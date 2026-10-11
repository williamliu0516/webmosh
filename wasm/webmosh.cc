/*
    webmosh: mosh-client's core as a WASM module, driven by JavaScript.

    Copyright 2012 Keith Winstein (mosh); webmosh glue 2026.
    GPLv3 or later, like mosh.

    This is src/frontend/stmclient.cc turned inside out. mosh-client blocks in select() on
    stdin, its UDP sockets and a timer; a browser cannot block, so JS calls in on each event
    instead (a datagram from the relay, keystrokes from xterm.js, a resize, a timer), and every
    call ends the way one turn of mosh-client's loop does: tick the transport, compute the new
    frame, and say how long to sleep. JS then drains two queues: screen bytes for xterm.js
    (wm_take_screen) and encrypted datagrams for the relay (wm_take_datagram).

    What stays mosh: the SSP transport, OCB encryption, the terminal emulator that holds the
    server's screen, the prediction engine (local echo) and the "Last contact" notification bar.
    What is dropped: termios, signals, the Ctrl-^ escape sequence (the page has its own controls).
*/

#include "config.h"

#include <emscripten/emscripten.h>
#include <locale.h>
#include <string>

#include "completeterminal.h"
#include "user.h"
#ifdef WEBMOSH_DEBUG
#define private public /* wm_debug reads the prediction engine's state */
#include "terminaloverlay.h"
#undef private
#else
#include "terminaloverlay.h"
#endif
#include "terminaldisplay.h"
#include "timestamp.h"
#include "fatal_assert.h"
#include "networktransport-impl.h"

typedef Network::Transport< Network::UserStream, Terminal::Complete > NetworkType;

namespace {

struct Client {
  NetworkType *network;
  Terminal::Framebuffer local_framebuffer, new_state;
  Overlay::OverlayManager overlays;
  Terminal::Display display;
  std::string screen;      /* bytes for xterm.js not yet taken */
  bool repaint_requested;
  bool connected_once;
  std::wstring connecting_notification;

  Client( int cols, int rows )
    : network( NULL ), local_framebuffer( cols, rows ), new_state( 1, 1 ), overlays(),
      display( false ), screen(), repaint_requested( false ), connected_once( false ),
      connecting_notification( L"Connecting..." ) {}
  ~Client() { delete network; }

  bool still_connecting( void ) const { return network && network->get_remote_state_num() == 0; }
};

Client *client = NULL;
std::string scratch;      /* what the last wm_take_* handed out; JS copies it before the next call */
std::string last_error;

void output_new_frame( void )
{
  Client &c = *client;
  c.new_state = c.network->get_latest_remote_state().state.get_fb();
  c.overlays.apply( c.new_state );
  c.screen += c.display.new_frame( !c.repaint_requested, c.local_framebuffer, c.new_state );
  c.repaint_requested = false;
  c.local_framebuffer = c.new_state;
}

void process_network_input( void )
{
  Client &c = *client;
  c.network->recv();

  c.overlays.get_notification_engine().server_heard( c.network->get_latest_remote_state().timestamp );
  c.overlays.get_notification_engine().server_acked( c.network->get_sent_state_acked_timestamp() );

  c.overlays.get_prediction_engine().set_local_frame_acked( c.network->get_sent_state_acked() );
  c.overlays.get_prediction_engine().set_send_interval( c.network->send_interval() );
  c.overlays.get_prediction_engine().set_local_frame_late_acked( c.network->get_latest_remote_state().state.get_echo_ack() );
}

/* The tail of one turn of STMClient::main(): connection notices, transport tick, new frame. */
int finish_turn( void )
{
  Client &c = *client;
  NetworkType &net = *c.network;

  if ( c.still_connecting() && !net.shutdown_in_progress()
       && ( timestamp() - net.get_latest_remote_state().timestamp > 250 ) ) {
    if ( timestamp() - net.get_latest_remote_state().timestamp > 15000 ) {
      c.overlays.get_notification_engine().set_notification_string( std::wstring( L"Timed out waiting for server..." ), true );
      net.start_shutdown();
    } else {
      c.overlays.get_notification_engine().set_notification_string( c.connecting_notification );
    }
  } else if ( net.get_remote_state_num() != 0
              && c.overlays.get_notification_engine().get_notification_string() == c.connecting_notification ) {
    c.overlays.get_notification_engine().set_notification_string( L"" );
  }
  if ( net.get_remote_state_num() != 0 ) {
    c.connected_once = true;
  }

  net.tick();

  std::string &send_error = net.get_send_error();
  if ( !send_error.empty() ) {
    c.overlays.get_notification_engine().set_network_error( send_error );
    send_error.clear();
  } else {
    c.overlays.get_notification_engine().clear_network_error();
  }

  output_new_frame();

  int wait_time = std::min( net.wait_time(), c.overlays.wait_time() );
  if ( c.still_connecting() ) {
    wait_time = std::min( 250, wait_time );
  }
  return wait_time;
}

/* Runs one event handler plus finish_turn(), with mosh-client's exception policy. Returns the
   ms to sleep before the next wm_tick(), or -1 after a fatal error (see wm_error). */
template < typename F >
int turn( F handler )
{
  if ( !client ) {
    last_error = "not started";
    return -1;
  }
  freeze_timestamp();
  try {
    handler();
    return finish_turn();
  } catch ( const Network::NetworkException &e ) {
    if ( e.the_errno != EAGAIN && !client->network->shutdown_in_progress() ) {
      client->overlays.get_notification_engine().set_network_error( e.what() );
    }
  } catch ( const Crypto::CryptoException &e ) {
    if ( e.fatal ) {
      last_error = std::string( "crypto: " ) + e.what();
      return -1;
    }
    /* a datagram that fails to authenticate is dropped, as in mosh-client */
  } catch ( const std::exception &e ) {
    last_error = e.what();
    return -1;
  }
  try {
    return finish_turn();
  } catch ( const std::exception &e ) {
    last_error = e.what();
    return -1;
  }
}

} /* namespace */

extern "C" {

/* Start a session. key is the 22-character key from "MOSH CONNECT <port> <key>"; port is only
   shown in messages. predict: "adaptive" (mosh's default), "always", "never" or "experimental". */
EMSCRIPTEN_KEEPALIVE int wm_start( const char *key, const char *port, int cols, int rows, const char *predict )
{
  setlocale( LC_ALL, "C.UTF-8" );
  freeze_timestamp();
  delete client;
  client = NULL;
  last_error.clear();
  try {
    client = new Client( cols, rows );
    Client &c = *client;

    std::string mode( predict ? predict : "adaptive" );
    Overlay::PredictionEngine &pe = c.overlays.get_prediction_engine();
    if ( mode == "always" ) {
      pe.set_display_preference( Overlay::PredictionEngine::Always );
    } else if ( mode == "never" ) {
      pe.set_display_preference( Overlay::PredictionEngine::Never );
    } else if ( mode == "experimental" ) {
      pe.set_display_preference( Overlay::PredictionEngine::Experimental );
    } else {
      pe.set_display_preference( Overlay::PredictionEngine::Adaptive );
    }

    /* application cursor keys: the server rewrites them for whatever mode the remote app wants */
    c.screen += c.display.open();
    c.screen += c.display.new_frame( false, c.local_framebuffer, c.local_framebuffer );

    Network::UserStream blank;
    Terminal::Complete local_terminal( cols, rows );
    c.network = new NetworkType( blank, local_terminal, key, "relay", port ? port : "" );
    c.network->set_send_delay( 1 ); /* minimal delay on outgoing keystrokes */
    c.network->get_current_state().push_back( Parser::Resize( cols, rows ) );
    return 0;
  } catch ( const std::exception &e ) {
    last_error = e.what();
    delete client;
    client = NULL;
    return -1;
  }
}

/* Keystrokes / pasted text from xterm.js (its onData, as UTF-8). */
EMSCRIPTEN_KEEPALIVE int wm_input( const char *buf, int len )
{
  return turn( [buf, len]() {
    Client &c = *client;
    NetworkType &net = *c.network;
    if ( net.shutdown_in_progress() ) {
      return;
    }
    c.overlays.get_prediction_engine().set_local_frame_sent( net.get_sent_state_last() );

    bool paste = len > 100; /* don't predict for bulk data */
    if ( paste ) {
      c.overlays.get_prediction_engine().reset();
    }
    for ( int i = 0; i < len; i++ ) {
      char the_byte = buf[ i ];
      if ( !paste ) {
        c.overlays.get_prediction_engine().new_user_byte( the_byte, c.local_framebuffer );
      }
      if ( the_byte == 0x0C ) { /* Ctrl-L */
        c.repaint_requested = true;
      }
      net.get_current_state().push_back( Parser::UserByte( the_byte ) );
    }
  } );
}

EMSCRIPTEN_KEEPALIVE int wm_resize( int cols, int rows )
{
  return turn( [cols, rows]() {
    Client &c = *client;
    if ( !c.network->shutdown_in_progress() ) {
      c.network->get_current_state().push_back( Parser::Resize( cols, rows ) );
    }
    c.overlays.get_prediction_engine().reset();
  } );
}

/* One encrypted datagram from the relay. */
EMSCRIPTEN_KEEPALIVE int wm_datagram( const char *buf, int len )
{
  return turn( [buf, len]() {
    Network::datagrams().in.push_back( std::string( buf, len ) );
    process_network_input();
  } );
}

/* The timer the previous call asked for has fired. */
EMSCRIPTEN_KEEPALIVE int wm_tick( void )
{
  return turn( []() {} );
}

/* xterm.js lost its contents (reset, reattached to a new element): redraw everything next frame. */
EMSCRIPTEN_KEEPALIVE int wm_repaint( void )
{
  return turn( []() {
    client->screen += client->display.open();
    client->repaint_requested = true;
  } );
}

/* Ask the server to end the session (mosh's Ctrl-^ .). */
EMSCRIPTEN_KEEPALIVE int wm_shutdown( void )
{
  return turn( []() {
    Client &c = *client;
    if ( !c.network->shutdown_in_progress() ) {
      c.overlays.get_notification_engine().set_notification_string( std::wstring( L"Exiting..." ), true );
      c.network->start_shutdown();
    }
  } );
}

/* Bit 0 connected (has heard the server), 1 shutdown in progress, 2 our shutdown acknowledged,
   3 shutdown ack timed out, 4 the server ended the session. Any of bits 2-4 means: done. */
EMSCRIPTEN_KEEPALIVE int wm_status( void )
{
  if ( !client || !client->network ) {
    return 0;
  }
  NetworkType &net = *client->network;
  return ( client->connected_once ? 1 : 0 )
    | ( net.shutdown_in_progress() ? 2 : 0 )
    | ( net.shutdown_in_progress() && net.shutdown_acknowledged() ? 4 : 0 )
    | ( net.shutdown_in_progress() && net.shutdown_ack_timed_out() ? 8 : 0 )
    | ( net.counterparty_shutdown_ack_sent() ? 16 : 0 );
}

/* Hand out the pending screen bytes; returns their length, read them at wm_scratch(). */
EMSCRIPTEN_KEEPALIVE int wm_take_screen( void )
{
  scratch.clear();
  if ( client ) {
    scratch.swap( client->screen );
  }
  return scratch.size();
}

/* Hand out the next datagram for the relay; returns its length (0 when none), read it at wm_scratch(). */
EMSCRIPTEN_KEEPALIVE int wm_take_datagram( void )
{
  scratch.clear();
  Network::Datagrams &d = Network::datagrams();
  if ( d.out.empty() ) {
    return 0;
  }
  scratch.swap( d.out.front() );
  d.out.pop_front();
  return scratch.size();
}

EMSCRIPTEN_KEEPALIVE const char *wm_scratch( void ) { return scratch.data(); }

EMSCRIPTEN_KEEPALIVE const char *wm_error( void ) { return last_error.c_str(); }

/* Milliseconds since the last datagram from the server (for the page's own connection badge). */
EMSCRIPTEN_KEEPALIVE double wm_since_heard( void )
{
  if ( !client || !client->network ) {
    return -1;
  }
  freeze_timestamp();
  return double( timestamp() - client->network->get_latest_remote_state().timestamp );
}

EMSCRIPTEN_KEEPALIVE int wm_hops( void ) { return Network::datagrams().hops; }

#ifdef WEBMOSH_DEBUG
EMSCRIPTEN_KEEPALIVE const char *wm_debug( void )
{
  static char out[ 512 ];
  if ( !client || !client->network ) {
    return "";
  }
  NetworkType &net = *client->network;
  Overlay::PredictionEngine &pe = client->overlays.get_prediction_engine();
  snprintf( out, sizeof out,
            "sent_last=%llu sent_acked=%llu remote=%llu echo_ack=%llu interval=%u | epoch pred=%llu conf=%llu "
            "frame sent=%llu acked=%llu late=%llu srtt_trigger=%d overlays=%zu",
            (unsigned long long)net.get_sent_state_last(), (unsigned long long)net.get_sent_state_acked(),
            (unsigned long long)net.get_remote_state_num(),
            (unsigned long long)net.get_latest_remote_state().state.get_echo_ack(), net.send_interval(),
            (unsigned long long)pe.prediction_epoch, (unsigned long long)pe.confirmed_epoch,
            (unsigned long long)pe.local_frame_sent, (unsigned long long)pe.local_frame_acked,
            (unsigned long long)pe.local_frame_late_acked, (int)pe.srtt_trigger, pe.overlays.size() );
  return out;
}
#endif

} /* extern "C" */
