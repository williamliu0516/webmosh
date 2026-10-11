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

    webmosh: src/network/network.cc with the sockets taken out (see network.h).
    Packet, timestamps, RTT and the receive checks are the original code.
*/

#include "config.h"

#include <assert.h>
#include <errno.h>
#include <stdio.h>
#include <string.h>

#include "dos_assert.h"
#include "fatal_assert.h"
#include "byteorder.h"
#include "network.h"
#include "crypto.h"

#include "timestamp.h"

using namespace Network;
using namespace Crypto;

const uint64_t DIRECTION_MASK = uint64_t(1) << 63;
const uint64_t SEQUENCE_MASK = uint64_t(-1) ^ DIRECTION_MASK;

Datagrams &Network::datagrams( void )
{
  static Datagrams d;
  return d;
}

/* Read in packet */
Packet::Packet( const Message & message )
  : seq( message.nonce.val() & SEQUENCE_MASK ),
    direction( (message.nonce.val() & DIRECTION_MASK) ? TO_CLIENT : TO_SERVER ),
    timestamp( -1 ),
    timestamp_reply( -1 ),
    payload()
{
  dos_assert( message.text.size() >= 2 * sizeof( uint16_t ) );

  const uint16_t *data = (uint16_t *)message.text.data();
  timestamp = be16toh( data[ 0 ] );
  timestamp_reply = be16toh( data[ 1 ] );

  payload = string( message.text.begin() + 2 * sizeof( uint16_t ), message.text.end() );
}

/* Output from packet */
Message Packet::toMessage( void )
{
  uint64_t direction_seq = (uint64_t( direction == TO_CLIENT ) << 63) | (seq & SEQUENCE_MASK);

  uint16_t ts_net[ 2 ] = { static_cast<uint16_t>( htobe16( timestamp ) ),
                           static_cast<uint16_t>( htobe16( timestamp_reply ) ) };

  string timestamps = string( (char *)ts_net, 2 * sizeof( uint16_t ) );

  return Message( Nonce( direction_seq ), timestamps + payload );
}

Packet Connection::new_packet( const string &s_payload )
{
  uint16_t outgoing_timestamp_reply = -1;

  uint64_t now = timestamp();

  if ( now - saved_timestamp_received_at < 1000 ) { /* we have a recent received timestamp */
    /* send "corrected" timestamp advanced by how long we held it */
    outgoing_timestamp_reply = saved_timestamp + (now - saved_timestamp_received_at);
    saved_timestamp = -1;
    saved_timestamp_received_at = 0;
  }

  Packet p( direction, timestamp16(), outgoing_timestamp_reply, s_payload );

  return p;
}

/* mosh-client opens a new UDP socket when nothing has come back for 10 s, in case a NAT dropped
   the old mapping. Here the relay owns the socket, so just count it; the page can ask the relay
   to rebind if it ever matters. */
void Connection::hop_port( void )
{
  assert( !server );
  setup();
  datagrams().hops++;
}

void Connection::setup( void )
{
  last_port_choice = timestamp();
}

Connection::Connection( const char *desired_ip __attribute((unused)),
                        const char *desired_port __attribute((unused)) ) /* server */
  : has_remote_addr( false ), remote_addr(), remote_addr_len( 0 ), server( true ), MTU( DEFAULT_SEND_MTU ),
    key(), session( key ), direction( TO_CLIENT ), saved_timestamp( -1 ), saved_timestamp_received_at( 0 ),
    expected_receiver_seq( 0 ), last_heard( -1 ), last_port_choice( -1 ), last_roundtrip_success( -1 ),
    RTT_hit( false ), SRTT( 1000 ), RTTVAR( 500 ), send_error(), remote_port()
{
  throw NetworkException( "webmosh is client-only", 0 );
}

Connection::Connection( const char *key_str, const char *ip __attribute((unused)), const char *port ) /* client */
  : has_remote_addr( true ), /* the relay is always there to take a datagram */
    remote_addr(),
    remote_addr_len( 0 ),
    server( false ),
    MTU( WEB_MTU ),
    key( key_str ),
    session( key ),
    direction( TO_SERVER ),
    saved_timestamp( -1 ),
    saved_timestamp_received_at( 0 ),
    expected_receiver_seq( 0 ),
    last_heard( -1 ),
    last_port_choice( -1 ),
    last_roundtrip_success( -1 ),
    RTT_hit( false ),
    SRTT( 1000 ),
    RTTVAR( 500 ),
    send_error(),
    remote_port( port ? port : "" )
{
  setup();
  remote_addr.sin.sin_family = AF_INET;
  remote_addr_len = sizeof( remote_addr.sin );
}

void Connection::send( const string & s )
{
  if ( !has_remote_addr ) {
    return;
  }

  Packet px = new_packet( s );

  datagrams().out.push_back( session.encrypt( px.toMessage() ) );

  uint64_t now = timestamp();
  if ( ( now - last_port_choice > PORT_HOP_INTERVAL )
       && ( now - last_roundtrip_success > PORT_HOP_INTERVAL ) ) {
    hop_port();
  }
}

string Connection::recv( void )
{
  Datagrams &d = datagrams();
  if ( d.in.empty() ) {
    throw NetworkException( "No packet received", EAGAIN );
  }
  string datagram;
  datagram.swap( d.in.front() );
  d.in.pop_front();

  if ( datagram.size() > static_cast<size_t>( Session::RECEIVE_MTU ) ) {
    throw NetworkException( "Received oversize datagram", EMSGSIZE );
  }

  Packet p( session.decrypt( datagram.data(), datagram.size() ) );

  dos_assert( p.direction == TO_CLIENT ); /* prevent malicious playback to sender */

  if ( p.seq < expected_receiver_seq ) { /* don't use (but do return) out-of-order packets for timestamp or targeting */
    return p.payload;
  }
  expected_receiver_seq = p.seq + 1; /* this is security-sensitive because a replay attack could otherwise
					screw up the timestamp and targeting */

  if ( p.timestamp != uint16_t(-1) ) {
    saved_timestamp = p.timestamp;
    saved_timestamp_received_at = timestamp();
  }

  if ( p.timestamp_reply != uint16_t(-1) ) {
    uint16_t now = timestamp16();
    double R = timestamp_diff( now, p.timestamp_reply );

    if ( R < 5000 ) { /* ignore large values, e.g. server was Ctrl-Zed */
      if ( !RTT_hit ) { /* first measurement */
	SRTT = R;
	RTTVAR = R / 2;
	RTT_hit = true;
      } else {
	const double alpha = 1.0 / 8.0;
	const double beta = 1.0 / 4.0;

	RTTVAR = (1 - beta) * RTTVAR + ( beta * fabs( SRTT - R ) );
	SRTT = (1 - alpha) * SRTT + ( alpha * R );
      }
    }
  }

  has_remote_addr = true;
  last_heard = timestamp();

  return p.payload;
}

uint64_t Network::timestamp( void )
{
  return frozen_timestamp();
}

uint16_t Network::timestamp16( void )
{
  uint16_t ts = timestamp() % 65536;
  if ( ts == uint16_t(-1) ) {
    ts++;
  }
  return ts;
}

uint16_t Network::timestamp_diff( uint16_t tsnew, uint16_t tsold )
{
  int diff = tsnew - tsold;
  if ( diff < 0 ) {
    diff += 65536;
  }

  assert( diff >= 0 );
  assert( diff <= 65535 );

  return diff;
}

uint64_t Connection::timeout( void ) const
{
  uint64_t RTO = lrint( ceil( SRTT + 4 * RTTVAR ) );
  if ( RTO < MIN_RTO ) {
    RTO = MIN_RTO;
  } else if ( RTO > MAX_RTO ) {
    RTO = MAX_RTO;
  }
  return RTO;
}
