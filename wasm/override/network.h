/*
    Mosh: the mobile shell
    Copyright 2012 Keith Winstein

    This program is free software: you can redistribute it and/or modify
    it under the terms of the GNU General Public License as published by
    the Free Software Foundation, either version 3 of the License, or
    (at your option) any later version.

    This program is distributed in the hope that it will be useful,
    but WITHOUT ANY WARRANTY; without even the implied warranty of
    MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
    GNU General Public License for more details.

    You should have received a copy of the GNU General Public License
    along with this program.  If not, see <http://www.gnu.org/licenses/>.

    webmosh: a copy of src/network/network.h whose Connection has no sockets.
    A browser cannot send UDP, so the client's encrypted datagrams go to and come
    from JavaScript (Datagrams below), which carries them over a WebRTC data
    channel to a relay that forwards them to an unmodified mosh-server.
    Everything above the socket (packet format, OCB encryption, sequence
    numbers, timestamps, RTT estimate) is unchanged.
*/

#ifndef NETWORK_HPP
#define NETWORK_HPP

#include <stdint.h>
#include <deque>
#include <sys/socket.h>
#include <netinet/in.h>
#include <string>
#include <math.h>
#include <vector>
#include <assert.h>
#include <exception>
#include <string.h>

#include "crypto.h"

using namespace Crypto;

namespace Network {
  static const unsigned int MOSH_PROTOCOL_VERSION = 2; /* bumped for echo-ack */

  uint64_t timestamp( void );
  uint16_t timestamp16( void );
  uint16_t timestamp_diff( uint16_t tsnew, uint16_t tsold );

  class NetworkException : public std::exception {
  public:
    string function;
    int the_errno;
  private:
    string my_what;
  public:
    NetworkException( string s_function="<none>", int s_errno=0)
      : function( s_function ), the_errno( s_errno ),
        my_what(function + ": " + strerror(the_errno)) {}
    const char *what() const throw () { return my_what.c_str(); }
    ~NetworkException() throw () {}
  };

  enum Direction {
    TO_SERVER = 0,
    TO_CLIENT = 1
  };

  class Packet {
  public:
    const uint64_t seq;
    Direction direction;
    uint16_t timestamp, timestamp_reply;
    string payload;

    Packet( Direction s_direction,
	    uint16_t s_timestamp, uint16_t s_timestamp_reply, const string & s_payload )
      : seq( Crypto::unique() ), direction( s_direction ),
	timestamp( s_timestamp ), timestamp_reply( s_timestamp_reply ), payload( s_payload )
    {}

    Packet( const Message & message );

    Message toMessage( void );
  };

  union Addr {
    struct sockaddr sa;
    struct sockaddr_in sin;
    struct sockaddr_in6 sin6;
    struct sockaddr_storage ss;
  };

  /* The datagram queues between the WASM client and JavaScript. One client per module instance. */
  struct Datagrams {
    std::deque< string > in;   /* encrypted datagrams from the relay, oldest first */
    std::deque< string > out;  /* encrypted datagrams for the relay */
    unsigned int hops;         /* times the client wanted a new source port (mosh's NAT-rebinding escape) */
    Datagrams() : in(), out(), hops( 0 ) {}
  };
  Datagrams &datagrams( void );

  class Connection {
  private:
    /* Tailscale's MTU is 1280; WireGuard and the data channel both add headers on top of ours. */
    static const int DEFAULT_SEND_MTU = 500;
    static const int WEB_MTU = 1100;

    static const uint64_t MIN_RTO = 50; /* ms */
    static const uint64_t MAX_RTO = 1000; /* ms */

    static const unsigned int PORT_HOP_INTERVAL = 10000;

    static const int CONGESTION_TIMESTAMP_PENALTY = 500; /* ms */

    bool has_remote_addr;
    Addr remote_addr;
    socklen_t remote_addr_len;

    bool server;

    int MTU; /* application datagram MTU */

    Base64Key key;
    Session session;

    void setup( void );

    Direction direction;
    uint16_t saved_timestamp;
    uint64_t saved_timestamp_received_at;
    uint64_t expected_receiver_seq;

    uint64_t last_heard;
    uint64_t last_port_choice;
    uint64_t last_roundtrip_success; /* transport layer needs to tell us this */

    bool RTT_hit;
    double SRTT;
    double RTTVAR;

    string send_error;
    string remote_port;

    Packet new_packet( const string &s_payload );

    void hop_port( void );

  public:
    /* Network transport overhead. */
    static const int ADDED_BYTES = 8 /* seqno/nonce */ + 4 /* timestamps */;

    Connection( const char *desired_ip, const char *desired_port ); /* server: not supported here */
    Connection( const char *key_str, const char *ip, const char *port ); /* client */

    void send( const string & s );
    string recv( void );
    const std::vector< int > fds( void ) const { return std::vector< int >(); }
    int get_MTU( void ) const { return MTU; }

    std::string port( void ) const { return remote_port; }
    string get_key( void ) const { return key.printable_key(); }
    bool get_has_remote_addr( void ) const { return has_remote_addr; }

    uint64_t timeout( void ) const;
    double get_SRTT( void ) const { return SRTT; }

    const Addr &get_remote_addr( void ) const { return remote_addr; }
    socklen_t get_remote_addr_len( void ) const { return remote_addr_len; }

    string &get_send_error( void )
    {
      return send_error;
    }

    void set_last_roundtrip_success( uint64_t s_success ) { last_roundtrip_success = s_success; }
  };
}

#endif
