/*
    Mosh: the mobile shell
    Copyright 2012 Keith Winstein
    GPLv3 or later, see COPYING.

    webmosh: replaces src/terminal/terminaldisplayinit.cc, which reads terminfo through curses.
    The local terminal is always xterm.js: it has ECH and BCE and takes titles, and the page
    owns the screen, so no smcup/rmcup.
*/

#include "config.h"
#include "terminaldisplay.h"

using namespace Terminal;

Display::Display( bool use_environment __attribute((unused)) )
  : has_ech( true ), has_bce( true ), has_title( true ), smcup( NULL ), rmcup( NULL )
{
}
