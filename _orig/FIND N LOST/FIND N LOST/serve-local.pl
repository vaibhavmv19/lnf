#!/usr/bin/perl
# serve-local.pl — preview host for the Lost N Found UI when Node.js is not installed.
#
# Usage:  perl serve-local.pl [port]      (default port 3000)
#
# It serves public/ with the same page routes as server.js, plus the read side of
# the JSON API built from data/db.json: browse, search, item detail, and member
# surfaces once you sign in (saved items, suggestions, notifications, inbox,
# profiles, leaderboard).
#
# Sign-in is Google-only for the RVU workspace: the ID token is verified in
# google-verify.pl and its hd claim must be the allowed domain. Sessions live in
# memory, so restarting this process signs everyone out. Writes (posting,
# messaging, claims, moderation) are not available; run "npm start" for those.
use strict;
use warnings;
use FindBin qw($Bin);
use IO::Socket::INET;
use IO::Select;
use JSON::PP ();
use Time::HiRes qw(time);

my $PORT   = $ARGV[0] || 3000;
my $ROOT   = $Bin;
my $PUBLIC = "$ROOT/public";

my $JSON = JSON::PP->new->utf8;

require "$ROOT/google-verify.pl" if -f "$ROOT/google-verify.pl";

# Google sign-in configuration, from the environment or a project-root .env file.
my $GOOGLE_CLIENT_ID = '';
my $GOOGLE_CLIENT_SECRET = '';
my $GOOGLE_DOMAIN    = 'mys.rvu.edu.in';

sub load_dotenv {
  open my $fh, '<:raw', "$ROOT/.env" or return;
  while (my $line = <$fh>) {
    chomp $line;
    next if $line =~ /^\s*(#|$)/;
    my ($key, $value) = $line =~ /^\s*([A-Za-z0-9_]+)\s*=\s*(.*?)\s*$/ or next;
    $value =~ s/^["']|["']$//g;
    $ENV{$key} = $value if !defined $ENV{$key} || !length $ENV{$key};
  }
  close $fh;
}

load_dotenv();
$GOOGLE_CLIENT_ID = defined $ENV{GOOGLE_CLIENT_ID} ? $ENV{GOOGLE_CLIENT_ID} : '';
$GOOGLE_CLIENT_ID =~ s/^\s+|\s+$//g;
$GOOGLE_CLIENT_SECRET = defined $ENV{GOOGLE_CLIENT_SECRET} ? $ENV{GOOGLE_CLIENT_SECRET} : '';
$GOOGLE_CLIENT_SECRET =~ s/^\s+|\s+$//g;
$GOOGLE_DOMAIN = lc(defined $ENV{GOOGLE_ALLOWED_DOMAIN} && length $ENV{GOOGLE_ALLOWED_DOMAIN}
  ? $ENV{GOOGLE_ALLOWED_DOMAIN} : 'mys.rvu.edu.in');

my $COOKIE_NAME = 'lnf_sid';
my $SESSION_TTL = 60 * 60 * 24 * 30;
my $READ_ONLY   = 'This preview is read-only for that action. Run npm start for the full app.';

my %PAGES = (
  '/'            => 'index.html',
  '/explore'     => 'explore.html',
  '/lost'        => 'lost.html',
  '/found'       => 'found.html',
  '/saved'       => 'saved.html',
  '/post'        => 'post.html',
  '/matches'     => 'matches.html',
  '/messages'    => 'messages.html',
  '/notifications' => 'notifications.html',
  '/settings'    => 'settings.html',
  '/leaderboard' => 'leaderboard.html',
  '/admin'       => 'admin.html',
  '/login'       => 'auth.html',
  '/signup'      => 'auth.html',
  '/auth'        => 'auth.html',
  '/404'         => '404.html',
);

my @DYNAMIC = (
  [qr{^/item/[A-Za-z0-9_-]+/?$},     'item.html'],
  [qr{^/messages/[A-Za-z0-9_-]+/?$}, 'conversation.html'],
  [qr{^/profile/[A-Za-z0-9_.-]+/?$}, 'profile.html'],
  [qr{^/collect/[A-Za-z0-9_.-]+/?$}, 'collect.html'],
);

my %MIME = (
  html => 'text/html; charset=utf-8',
  htm  => 'text/html; charset=utf-8',
  css  => 'text/css; charset=utf-8',
  js   => 'application/javascript; charset=utf-8',
  json => 'application/json; charset=utf-8',
  svg  => 'image/svg+xml',
  png  => 'image/png',
  jpg  => 'image/jpeg',
  jpeg => 'image/jpeg',
  webp => 'image/webp',
  gif  => 'image/gif',
  ico  => 'image/x-icon',
  woff2 => 'font/woff2',
  txt  => 'text/plain; charset=utf-8',
);

my %REASON = (
  200 => 'OK', 204 => 'No Content', 400 => 'Bad Request', 401 => 'Unauthorized',
  302 => 'Found',
  403 => 'Forbidden', 404 => 'Not Found', 405 => 'Method Not Allowed',
  500 => 'Internal Server Error',
);

my %SESSIONS;   # sid => { userId, createdAt }

sub read_db {
  open my $fh, '<:raw', "$ROOT/data/db.json" or return {};
  local $/;
  my $raw = <$fh>;
  close $fh;
  my $db = eval { $JSON->decode($raw) };
  if ($@) { warn "[db] $@"; return {}; }
  return $db || {};
}

my $DB = read_db();

sub urldecode {
  my ($s) = @_;
  $s = '' unless defined $s;
  $s =~ tr/+/ /;
  $s =~ s/%([0-9A-Fa-f]{2})/chr(hex($1))/ge;
  return $s;
}

sub lower {
  my ($s) = @_;
  $s = '' unless defined $s;
  $s =~ s/^\s+|\s+$//g;
  return lc $s;
}

sub users      { return @{ $DB->{users} || [] } }
sub listings   { return @{ $DB->{listings} || [] } }

sub find_user {
  my ($needle) = @_;
  $needle = lower($needle);
  for my $user (users()) {
    return $user if lower($user->{username}) eq $needle;
  }
  return undef;
}

sub user_by_id {
  my ($id) = @_;
  return undef unless defined $id;
  for my $user (users()) {
    return $user if ($user->{id} || '') eq $id;
  }
  return undef;
}

sub user_by_email {
  my ($email) = @_;
  $email = lower($email);
  for my $user (users()) {
    return $user if lower($user->{email}) eq $email;
  }
  return undef;
}

sub listing_by_id {
  my ($id) = @_;
  return undef unless defined $id;
  for my $listing (listings()) {
    return $listing if ($listing->{id} || '') eq $id;
  }
  return undef;
}

sub search_text {
  my ($listing) = @_;
  my $text = join ' ', map { defined $_ ? $_ : '' }
    @{$listing}{qw(title description brand color city area category)};
  return lower($text);
}

sub owner_of {
  my ($listing) = @_;
  return user_by_id($listing->{userId});
}

sub saved_ids_for {
  my ($viewer) = @_;
  return () unless $viewer;
  return map { $_->{listingId} }
    grep { ($_->{userId} || '') eq $viewer->{id} } @{ $DB->{saved} || [] };
}

sub listing_dto {
  my ($listing, $viewer) = @_;
  my $owner = owner_of($listing);
  my $images = ref($listing->{images}) eq 'ARRAY' ? $listing->{images} : [];
  my $first = @$images ? $images->[0] : undef;
  my $is_owner = ($viewer && ($viewer->{id} || '') eq ($listing->{userId} || '')) ? 1 : 0;
  my $can_edit = $viewer && ($is_owner || ($viewer->{role} || '') eq 'admin') ? 1 : 0;
  my %saved = $viewer ? map { $_ => 1 } saved_ids_for($viewer) : ();
  my $dto = {
    id            => $listing->{id},
    type          => $listing->{type},
    title         => $listing->{title},
    description   => defined $listing->{description} ? $listing->{description} : '',
    category      => $listing->{category},
    brand         => defined $listing->{brand} ? $listing->{brand} : '',
    color         => defined $listing->{color} ? $listing->{color} : '',
    city          => $listing->{city},
    area          => defined $listing->{area} ? $listing->{area} : '',
    incidentDate  => $listing->{incidentDate},
    status        => $listing->{status},
    reward        => $listing->{reward} || 0,
    createdAt     => $listing->{createdAt},
    returnedAt    => $listing->{returnedAt},
    images        => $images,
    image         => $first,
    owner         => $owner ? {
      username          => $owner->{username},
      fullName          => $owner->{fullName},
      city              => defined $owner->{city} ? $owner->{city} : '',
      avatarUrl         => $owner->{avatarUrl},
      reputation        => $owner->{reputation} || 0,
      successfulReturns => $owner->{successfulReturns} || 0,
    } : undef,
    isOwner          => ($is_owner ? \1 : \0),
    saved            => ($saved{ $listing->{id} || '' } ? \1 : \0),
    claimCount       => scalar @{ $listing->{claims} || [] },
    canEdit          => ($can_edit ? \1 : \0),
    hasPrivateDetail => ($listing->{privateDetail} ? \1 : \0),
    collected        => \0,
    canCollect       => \0,
    collection       => undef,
  };
  $dto->{privateDetail} = defined $listing->{privateDetail} ? $listing->{privateDetail} : '' if $can_edit;
  return $dto;
}

sub query_listings {
  my (%p) = @_;
  my $viewer = $p{viewer};
  my @all = listings();
  my $status = $p{status} || '';
  my @items = $status
    ? grep { ($_->{status} || '') eq $status } @all
    : grep { ($_->{status} || '') ne 'removed' } @all;

  if ($p{type})     { @items = grep { ($_->{type} || '') eq $p{type} } @items }
  if ($p{category}) { @items = grep { ($_->{category} || '') eq $p{category} } @items }
  if ($p{city}) {
    my $city = lower($p{city});
    @items = grep { index(lower($_->{city}), $city) >= 0 } @items;
  }
  if ($p{from}) { @items = grep { ($_->{incidentDate} || '') ge $p{from} } @items }
  if ($p{to})   { @items = grep { ($_->{incidentDate} || '') le $p{to} } @items }
  if ($p{owner}) {
    my $user = find_user($p{owner});
    @items = $user ? grep { ($_->{userId} || '') eq $user->{id} } @items : ();
  }
  if ($p{mine}) {
    return { error => 401 } unless $viewer;
    @items = grep { ($_->{userId} || '') eq $viewer->{id} } @items;
  }
  if ($p{saved}) {
    return { error => 401 } unless $viewer;
    my %ids = map { $_ => 1 } saved_ids_for($viewer);
    @items = grep { $ids{ $_->{id} || '' } } @items;
  }
  if ($p{q}) {
    my @tokens = grep { length } split /\s+/, lower($p{q});
    @items = grep {
      my $text = search_text($_);
      my $ok = 1;
      for my $token (@tokens) {
        if (index($text, $token) < 0) { $ok = 0; last }
      }
      $ok;
    } @items;
  }

  my $sort = $p{sort} || 'recent';
  if ($sort eq 'oldest') {
    @items = sort { ($a->{createdAt} || '') cmp ($b->{createdAt} || '') } @items;
  } elsif ($sort eq 'returned') {
    @items = sort {
      (($a->{status} || '') eq ($b->{status} || '') ? 0 : (($a->{status} || '') eq 'returned' ? -1 : 1))
        || (($b->{createdAt} || '') cmp ($a->{createdAt} || ''))
    } @items;
  } else {
    @items = sort { ($b->{createdAt} || '') cmp ($a->{createdAt} || '') } @items;
  }

  my $total  = scalar @items;
  my $offset = int($p{offset} || 0);
  $offset = 0 if $offset < 0;
  my $limit = int($p{limit} || 24);
  $limit = 24 if $limit < 1;
  $limit = 48 if $limit > 48;

  my @page;
  if ($offset < $total) {
    my $last = $offset + $limit - 1;
    $last = $total - 1 if $last > $total - 1;
    @page = @items[$offset .. $last];
  }

  return {
    items   => [ map { listing_dto($_, $viewer) } @page ],
    total   => $total,
    hasMore => ($offset + scalar(@page) < $total ? \1 : \0),
  };
}

sub meta_payload {
  my %counts;
  my %cities;
  for my $listing (listings()) {
    next if ($listing->{status} || '') eq 'removed';
    $counts{ $listing->{category} || 'Other' } += 1;
    $cities{ $listing->{city} } = 1 if $listing->{city};
  }
  return {
    categories => [ map { { name => $_, count => $counts{$_} } }
                    sort { $counts{$b} <=> $counts{$a} || $a cmp $b } keys %counts ],
    cities     => [ sort keys %cities ],
    colors     => [qw(black white grey silver blue navy teal green olive yellow gold orange red maroon pink purple brown beige clear)],
    reportReasons => [
      'Possible scam or fraud',
      'Inappropriate or unsafe content',
      'Spam or duplicate listing',
      'Harassment or abusive messages',
      'Item listed in the wrong category',
      'Something else',
    ],
    thresholds => { suggest => 0.45, notify => 0.62 },
  };
}

sub stats_payload {
  my @active = grep { ($_->{status} || '') ne 'removed' } listings();
  my %cities;
  $cities{ $_->{city} } = 1 for grep { $_->{city} } @active;
  return {
    listings => scalar @active,
    lost     => scalar(grep { ($_->{type} || '') eq 'lost' } @active),
    found    => scalar(grep { ($_->{type} || '') eq 'found' } @active),
    reunited => scalar(grep { ($_->{status} || '') eq 'returned' } @active),
    members  => scalar users(),
    cities   => scalar keys %cities,
    matches  => scalar @{ $DB->{matches} || [] },
  };
}

sub public_user {
  my ($user, $viewer) = @_;
  return undef unless $user;
  my $is_self = ($viewer && ($viewer->{id} || '') eq ($user->{id} || '')) ? 1 : 0;
  my $dto = {
    id                => $is_self ? $user->{id} : undef,
    username          => $user->{username},
    fullName          => $user->{fullName},
    avatarUrl         => $user->{avatarUrl},
    bio               => defined $user->{bio} ? $user->{bio} : '',
    city              => defined $user->{city} ? $user->{city} : '',
    role              => $user->{role},
    reputation        => $user->{reputation} || 0,
    successfulReturns => $user->{successfulReturns} || 0,
    createdAt         => $user->{createdAt},
    isAdmin           => ($user->{role} || '') eq 'admin' ? \1 : \0,
    isMe              => ($is_self ? \1 : \0),
  };
  if ($is_self) {
    $dto->{email} = $user->{email};
    $dto->{prefs} = $user->{prefs} || { emailMatches => \1, emailMessages => \1, emailUpdates => \0 };
  }
  return $dto;
}

sub achievements_for {
  my ($user) = @_;
  my $posts   = scalar grep { ($_->{userId} || '') eq ($user->{id} || '') } listings();
  my $returns = $user->{successfulReturns} || 0;
  my @list;
  push @list, { id => 'first-post', label => 'First report', description => 'Shared a first lost or found listing.' } if $posts >= 1;
  push @list, { id => 'five-posts', label => 'Regular reporter', description => 'Five listings shared with the community.' } if $posts >= 5;
  push @list, { id => 'first-return', label => 'First reunion', description => 'Helped return something to its owner.' } if $returns >= 1;
  push @list, { id => 'three-returns', label => 'Trusted finder', description => 'Three verified reunions and counting.' } if $returns >= 3;
  push @list, { id => 'reputation', label => 'Community pillar', description => 'Recognised for helpful, careful behaviour.' } if ($user->{reputation} || 0) >= 50;
  return \@list;
}

sub unread_count {
  my ($user) = @_;
  return 0 unless $user;
  return scalar grep { ($_->{userId} || '') eq $user->{id} && !$_->{isRead} } @{ $DB->{notifications} || [] };
}

sub match_dto {
  my ($match, $viewer) = @_;
  my $score = $match->{similarityScore};
  $score = 0 unless defined $score;
  my $label = $score >= 0.78 ? 'Strong possible match'
            : $score >= 0.6  ? 'Good possible match'
            : 'Other similar items';
  my $tier = $score >= 0.78 ? 'strong' : $score >= 0.6 ? 'good' : 'similar';
  my $lost  = listing_by_id($match->{lostListingId});
  my $found = listing_by_id($match->{foundListingId});
  return {
    id        => $match->{id},
    score     => $score + 0,
    similarityScore => $score + 0,
    parts     => $match->{parts} || {},
    status    => $match->{status},
    label     => $label,
    tier      => $tier,
    createdAt => $match->{createdAt},
    lost      => $lost  ? listing_dto($lost,  $viewer) : undef,
    found     => $found ? listing_dto($found, $viewer) : undef,
  };
}

sub matches_for {
  my ($user) = @_;
  my @rows;
  for my $match (@{ $DB->{matches} || [] }) {
    next if ($match->{status} || '') eq 'dismissed';
    my $lost  = listing_by_id($match->{lostListingId});
    my $found = listing_by_id($match->{foundListingId});
    next unless $lost && $found;
    next unless ($lost->{userId} || '') eq ($user->{id} || '') || ($found->{userId} || '') eq ($user->{id} || '');
    push @rows, $match;
  }
  @rows = sort { ($b->{similarityScore} || 0) <=> ($a->{similarityScore} || 0) } @rows;
  return [ map { match_dto($_, $user) } @rows ];
}

sub notifications_for {
  my ($user) = @_;
  my @items = grep { ($_->{userId} || '') eq ($user->{id} || '') } @{ $DB->{notifications} || [] };
  @items = sort { ($b->{createdAt} || '') cmp ($a->{createdAt} || '') } @items;
  return [ map {
    {
      id          => $_->{id},
      type        => $_->{type},
      title       => $_->{title},
      body        => $_->{body},
      referenceId => $_->{referenceId},
      isRead      => ($_->{isRead} ? \1 : \0),
      createdAt   => $_->{createdAt},
    }
  } @items ];
}

sub last_message_for {
  my ($conversation) = @_;
  my @msgs = grep { ($_->{conversationId} || '') eq ($conversation->{id} || '') } @{ $DB->{messages} || [] };
  @msgs = sort { ($a->{createdAt} || '') cmp ($b->{createdAt} || '') } @msgs;
  return $msgs[-1];
}

sub conversations_for {
  my ($user) = @_;
  my @rows;
  for my $conv (@{ $DB->{conversations} || [] }) {
    my @members = @{ $conv->{memberIds} || [] };
    next unless grep { $_ eq ($user->{id} || '') } @members;
    my ($other_id) = grep { $_ ne ($user->{id} || '') } @members;
    my $other = user_by_id($other_id);
    my $listing = listing_by_id($conv->{listingId});
    my $last = last_message_for($conv);
    my @msgs = grep { ($_->{conversationId} || '') eq ($conv->{id} || '') } @{ $DB->{messages} || [] };
    my $unread = scalar grep { ($_->{senderId} || '') ne ($user->{id} || '') && !$_->{readAt} } @msgs;
    push @rows, {
      id        => $conv->{id},
      other     => $other ? {
        username => $other->{username},
        fullName => $other->{fullName},
        city     => defined $other->{city} ? $other->{city} : '',
        avatarUrl => $other->{avatarUrl},
      } : undef,
      listing   => $listing ? {
        id    => $listing->{id},
        title => $listing->{title},
        image => (ref($listing->{images}) eq 'ARRAY' ? $listing->{images}[0] : undef),
      } : undef,
      lastMessage => $last ? {
        body => $last->{body},
        mine => (($last->{senderId} || '') eq ($user->{id} || '') ? \1 : \0),
        createdAt => $last->{createdAt},
      } : undef,
      unread    => $unread,
      updatedAt => $conv->{updatedAt} || ($last ? $last->{createdAt} : $conv->{createdAt}),
    };
  }
  @rows = sort { ($b->{updatedAt} || '') cmp ($a->{updatedAt} || '') } @rows;
  return \@rows;
}

sub send_all {
  my ($sock, $data) = @_;
  my $offset = 0;
  my $length = length $data;
  while ($offset < $length) {
    my $written = syswrite($sock, $data, $length - $offset, $offset);
    last unless defined $written && $written > 0;
    $offset += $written;
  }
}

sub respond {
  my ($sock, $status, $type, $body, $head_only, $extra) = @_;
  $body = '' unless defined $body;
  my $head = "HTTP/1.1 $status " . ($REASON{$status} || 'OK') . "\r\n"
    . "Content-Type: $type\r\n"
    . 'Content-Length: ' . length($body) . "\r\n"
    . "Cache-Control: no-store\r\n"
    . (defined $extra ? $extra : '')
    . "Connection: close\r\n"
    . "X-Content-Type-Options: nosniff\r\n\r\n";
  send_all($sock, $head_only ? $head : $head . $body);
}

sub respond_redirect {
  my ($sock, $location, $head_only, $extra) = @_;
  respond($sock, 302, 'text/html; charset=utf-8', 'Redirecting…', $head_only,
    "Location: $location\r\n" . (defined $extra ? $extra : ''));
}

sub respond_json {
  my ($sock, $status, $data, $head_only, $extra) = @_;
  my $body = eval { $JSON->encode($data) };
  $body = '{"error":"Could not encode response."}' if $@;
  respond($sock, $status, 'application/json; charset=utf-8', $body, $head_only, $extra);
}

sub send_file {
  my ($sock, $file, $head_only) = @_;
  open my $fh, '<:raw', $file or do {
    respond($sock, 404, 'text/plain; charset=utf-8', 'Not found.');
    return;
  };
  local $/;
  my $body = <$fh>;
  close $fh;
  my ($ext) = $file =~ /\.([A-Za-z0-9]+)$/;
  my $type = $MIME{ lc($ext || '') } || 'application/octet-stream';
  respond($sock, 200, $type, $body, $head_only);
}

# --- sessions ---------------------------------------------------------------

sub cookies_from {
  my ($head) = @_;
  my %cookies;
  for my $line (split /\r\n/, ($head || '')) {
    next unless $line =~ /^Cookie:\s*(.*)$/i;
    for my $pair (split /;\s*/, $1) {
      my ($key, $value) = split /=/, $pair, 2;
      next unless defined $key && length $key;
      $cookies{$key} = defined $value ? $value : '';
    }
  }
  return %cookies;
}

sub current_user {
  my ($head) = @_;
  my %cookies = cookies_from($head);
  my $sid = $cookies{$COOKIE_NAME};
  return undef unless defined $sid && length $sid;
  my $session = $SESSIONS{$sid};
  return undef unless $session;
  if (time - $session->{createdAt} > $SESSION_TTL) {
    delete $SESSIONS{$sid};
    return undef;
  }
  return user_by_id($session->{userId});
}

sub new_session {
  my ($user) = @_;
  my @bytes = map { int rand 256 } 1 .. 32;
  my $sid = unpack 'H*', pack 'C*', @bytes;
  $SESSIONS{$sid} = { userId => $user->{id}, createdAt => time };
  return $sid;
}

sub cookie_header {
  my ($value, $max_age) = @_;
  return "Set-Cookie: $COOKIE_NAME=$value; Path=/; Max-Age=$max_age; HttpOnly; SameSite=Lax\r\n";
}

# --- google sign-in ---------------------------------------------------------

my %OAUTH_STATES;   # state => { next, expires }

sub uri_escape {
  my ($s) = @_;
  $s = '' unless defined $s;
  $s =~ s/([^A-Za-z0-9\-_.~])/sprintf '%%%02X', ord($1)/ge;
  return $s;
}

sub safe_next {
  my ($value) = @_;
  $value = '' unless defined $value;
  return '/' unless $value =~ m{^/(?!/)};
  return $value;
}

# The redirect URI must be identical when authorising and when redeeming the
# code, so it is derived from the request host (loopback only).
sub loopback_origin {
  my ($head) = @_;
  if (defined $head && $head =~ /^host:\s*(\S+)\s*$/mi) {
    my $host = $1;
    return "http://$host" if $host =~ /^(?:localhost|127\.0\.0\.1)(?::\d{1,5})?$/i;
  }
  return 'http://localhost:3000';
}

sub new_oauth_state {
  my ($next) = @_;
  for my $key (keys %OAUTH_STATES) {
    delete $OAUTH_STATES{$key} if $OAUTH_STATES{$key}{expires} < time;
  }
  my $state = unpack 'H*', pack 'C*', map { int rand 256 } 1 .. 16;
  $OAUTH_STATES{$state} = { next => safe_next($next), expires => time + 600 };
  return $state;
}

sub google_auth_url {
  my ($state, $redirect_uri) = @_;
  my @query = (
    'client_id=' . uri_escape($GOOGLE_CLIENT_ID),
    'redirect_uri=' . uri_escape($redirect_uri),
    'response_type=code',
    'scope=' . uri_escape('openid email profile'),
    'hd=' . uri_escape($GOOGLE_DOMAIN),
    'prompt=select_account',
    'access_type=online',
    'state=' . uri_escape($state),
  );
  return 'https://accounts.google.com/o/oauth2/v2/auth?' . join('&', @query);
}

sub exchange_code {
  my ($code, $redirect_uri) = @_;
  my $raw = '';
  if (open my $fh, '-|', 'curl', '-s', '--max-time', '15', '-X', 'POST',
      '--data-urlencode', 'grant_type=authorization_code',
      '--data-urlencode', "code=$code",
      '--data-urlencode', "client_id=$GOOGLE_CLIENT_ID",
      '--data-urlencode', "client_secret=$GOOGLE_CLIENT_SECRET",
      '--data-urlencode', "redirect_uri=$redirect_uri",
      'https://oauth2.googleapis.com/token') {
    local $/;
    $raw = <$fh> // '';
    close $fh;
  }
  my $parsed = eval { $JSON->decode($raw) };
  return (undef, 'Google did not answer the sign-in request. Please try again.')
    unless ref($parsed) eq 'HASH';
  return (undef, 'Google rejected that sign-in. Please start again.')
    if defined $parsed->{error};
  my $id_token = $parsed->{id_token};
  return (undef, 'Google did not return an identity token for that account.')
    unless defined $id_token && length $id_token;
  return ($id_token, undef);
}

sub iso_now {
  my @t = gmtime;
  return sprintf '%04d-%02d-%02dT%02d:%02d:%02d.000Z',
    $t[5] + 1900, $t[4] + 1, $t[3], $t[2], $t[1], $t[0];
}

sub unique_username {
  my ($base) = @_;
  my $candidate = $base;
  my $suffix = 0;
  while (find_user($candidate)) {
    $suffix++;
    last if $suffix > 999;
    my $tail = "$suffix";
    my $keep = 20 - length($tail);
    $keep = 1 if $keep < 1;
    $candidate = substr($base, 0, $keep) . $tail;
  }
  return $candidate;
}

sub find_or_create_google_user {
  my ($profile) = @_;
  my $email = lc($profile->{email} || '');
  my ($existing) = grep { lc($_->{email} || '') eq $email } users();
  if ($existing) {
    $existing->{googleSub}    = $profile->{sub};
    $existing->{lastSignInAt} = iso_now();
    $existing->{avatarUrl}    = $profile->{picture}
      if !$existing->{avatarUrl} && $profile->{picture};
    return $existing;
  }
  my ($local) = split /\@/, $email;
  $local = lc($local || '');
  $local =~ s/[^a-z0-9_]//g;
  $local = substr($local, 0, 20);
  $local = 'member' if length($local) < 3;
  my $user = {
    id                => 'u_' . unpack('H*', pack('C*', map { int rand 256 } 1 .. 8)),
    username          => unique_username($local),
    email             => $email,
    fullName          => length($profile->{name} || '') ? $profile->{name} : $local,
    avatarUrl         => $profile->{picture},
    bio               => '',
    city              => '',
    role              => 'member',
    googleSub         => $profile->{sub},
    reputation        => 0,
    successfulReturns => 0,
    createdAt         => iso_now(),
    prefs             => { emailMatches => \1, emailMessages => \1, emailUpdates => \0 },
  };
  push @{ $DB->{users} }, $user;
  return $user;
}

# --- api --------------------------------------------------------------------

sub handle_api {
  my ($sock, $method, $path, $params, $head, $body, $head_only) = @_;
  my $viewer = current_user($head);
  my $is_get = ($method eq 'GET' || $method eq 'HEAD');

  if ($path eq '/api/auth/config') {
    respond_json($sock, 200, {
      googleClientId => (length $GOOGLE_CLIENT_ID ? $GOOGLE_CLIENT_ID : undef),
      googleDomain   => $GOOGLE_DOMAIN,
      googleEnabled  => (length $GOOGLE_CLIENT_ID ? \1 : \0),
    }, $head_only);
    return;
  }

  if ($path eq '/api/auth/google/start') {
    if (!length $GOOGLE_CLIENT_ID || !length $GOOGLE_CLIENT_SECRET) {
      respond_redirect($sock, '/auth?error=' . uri_escape('Google sign-in is not configured on this copy.'), $head_only);
      return;
    }
    if ($viewer) {
      respond_redirect($sock, safe_next($params->{next}), $head_only);
      return;
    }
    my $redirect_uri = loopback_origin($head) . '/api/auth/google/callback';
    my $state = new_oauth_state($params->{next});
    respond_redirect($sock, google_auth_url($state, $redirect_uri), $head_only);
    return;
  }

  if ($path eq '/api/auth/google/callback') {
    my $state = defined $params->{state} ? $params->{state} : '';
    my $entry = delete $OAUTH_STATES{$state};
    my $fail = sub {
      respond_redirect($sock, '/auth?error=' . uri_escape($_[0]), $head_only);
    };
    if (!$entry || $entry->{expires} < time) {
      $fail->('That sign-in link expired. Please try again.');
      return;
    }
    if (length($params->{error} || '')) {
      $fail->('Google sign-in was cancelled.');
      return;
    }
    my $code = defined $params->{code} ? $params->{code} : '';
    if (!length $code) {
      $fail->('Google did not return an authorisation code.');
      return;
    }
    my $redirect_uri = loopback_origin($head) . '/api/auth/google/callback';
    my ($id_token, $exchange_error) = exchange_code($code, $redirect_uri);
    if (!$id_token) {
      $fail->($exchange_error || 'Google rejected that sign-in. Please start again.');
      return;
    }
    my ($profile, $verify_error) = GoogleVerify::verify(
      jwt       => $id_token,
      client_id => $GOOGLE_CLIENT_ID,
      domain    => $GOOGLE_DOMAIN,
    );
    if (!$profile) {
      $fail->($verify_error || 'That Google account cannot sign in here.');
      return;
    }
    my $user = find_or_create_google_user($profile);
    my $sid = new_session($user);
    respond_redirect($sock, $entry->{next} || '/', $head_only, cookie_header($sid, $SESSION_TTL));
    return;
  }

  if ($path eq '/api/auth/logout') {
    if ($method ne 'POST') {
      respond_json($sock, 405, { error => 'Use POST to sign out.' }, $head_only);
      return;
    }
    my %cookies = cookies_from($head);
    delete $SESSIONS{ $cookies{$COOKIE_NAME} } if defined $cookies{$COOKIE_NAME};
    respond_json($sock, 200, { ok => \1 }, $head_only, cookie_header('', 0));
    return;
  }

  if ($path eq '/api/auth/me') {
    if (!$viewer) {
      respond_json($sock, 200, { user => undef, unread => 0, savedIds => [], achievements => [] }, $head_only);
      return;
    }
    respond_json($sock, 200, {
      user         => public_user($viewer, $viewer),
      unread       => unread_count($viewer),
      savedIds     => [ saved_ids_for($viewer) ],
      achievements => achievements_for($viewer),
    }, $head_only);
    return;
  }

  if ($path eq '/api/meta') {
    respond_json($sock, 200, meta_payload(), $head_only);
    return;
  }
  if ($path eq '/api/stats') {
    respond_json($sock, 200, stats_payload(), $head_only);
    return;
  }

  if ($path eq '/api/listings') {
    my %query = %$params;
    $query{viewer} = $viewer;
    my $result = query_listings(%query);
    if (ref($result) eq 'HASH' && ($result->{error} || 0) == 401) {
      respond_json($sock, 401, { error => 'Please sign in to see your listings.' }, $head_only);
      return;
    }
    respond_json($sock, 200, $result, $head_only);
    return;
  }

  if ($path =~ m{^/api/listings/([^/]+)$}) {
    my $id = urldecode($1);
    my $listing = listing_by_id($id);
    if (!$listing || ($listing->{status} || '') eq 'removed') {
      respond_json($sock, 404, { error => 'That listing could not be found.' }, $head_only);
      return;
    }
    my @related = grep {
      ($_->{id} || '') ne $id
        && ($_->{status} || '') eq 'active'
        && ($_->{category} || '') eq ($listing->{category} || '')
        && ($_->{type} || '') eq ($listing->{type} || '')
    } listings();
    @related = sort { ($b->{createdAt} || '') cmp ($a->{createdAt} || '') } @related;
    splice(@related, 4) if @related > 4;

    my $match_dto;
    if ($viewer) {
      for my $match (@{ $DB->{matches} || [] }) {
        next unless ($match->{lostListingId} || '') eq $id || ($match->{foundListingId} || '') eq $id;
        next if ($match->{status} || '') eq 'dismissed';
        my $lost  = listing_by_id($match->{lostListingId});
        my $found = listing_by_id($match->{foundListingId});
        next unless $lost && $found;
        next unless ($lost->{userId} || '') eq ($viewer->{id} || '') || ($found->{userId} || '') eq ($viewer->{id} || '');
        $match_dto = match_dto($match, $viewer);
        last;
      }
    }

    respond_json($sock, 200, {
      item    => listing_dto($listing, $viewer),
      related => [ map { listing_dto($_, $viewer) } @related ],
      match   => $match_dto,
    }, $head_only);
    return;
  }

  # Everything below needs a signed-in member.
  if (!$viewer) {
    if ($path =~ m{^/api/(saved|matches|notifications|messages|leaderboard|users)/}
        || $path =~ m{^/api/(saved|matches|notifications|messages|conversations)$}) {
      respond_json($sock, 401, { error => 'Please sign in to continue.' }, $head_only);
      return;
    }
  }

  if ($path eq '/api/saved') {
    my @rows = grep { ($_->{userId} || '') eq ($viewer->{id} || '') } @{ $DB->{saved} || [] };
    my @items;
    for my $row (@rows) {
      my $listing = listing_by_id($row->{listingId});
      next unless $listing && ($listing->{status} || '') ne 'removed';
      push @items, listing_dto($listing, $viewer);
    }
    respond_json($sock, 200, { items => \@items, total => scalar @items, hasMore => \0 }, $head_only);
    return;
  }

  if ($path eq '/api/notifications') {
    respond_json($sock, 200, {
      items  => notifications_for($viewer),
      unread => unread_count($viewer),
    }, $head_only);
    return;
  }

  if ($path eq '/api/matches') {
    respond_json($sock, 200, { items => matches_for($viewer) }, $head_only);
    return;
  }

  if ($path eq '/api/leaderboard') {
    my @ranked = sort {
      ($b->{successfulReturns} || 0) <=> ($a->{successfulReturns} || 0)
        || ($b->{reputation} || 0) <=> ($a->{reputation} || 0)
        || lower($a->{fullName}) cmp lower($b->{fullName})
    } grep { ($_->{role} || '') ne 'admin' || ($_->{successfulReturns} || 0) > 0 } users();
    my @items;
    my $rank = 0;
    for my $user (@ranked) {
      $rank++;
      my $count = scalar grep { ($_->{userId} || '') eq ($user->{id} || '') && ($_->{status} || '') ne 'removed' } listings();
      push @items, {
        rank              => $rank,
        username          => $user->{username},
        fullName          => $user->{fullName},
        city              => defined $user->{city} ? $user->{city} : '',
        avatarUrl         => $user->{avatarUrl},
        reputation        => $user->{reputation} || 0,
        successfulReturns => $user->{successfulReturns} || 0,
        listings          => $count,
        isMe              => (($user->{id} || '') eq ($viewer->{id} || '') ? \1 : \0),
      };
    }
    respond_json($sock, 200, { items => \@items }, $head_only);
    return;
  }

  if ($path =~ m{^/api/users/([^/]+)$}) {
    my $user = find_user(urldecode($1));
    if (!$user) {
      respond_json($sock, 404, { error => 'That member could not be found.' }, $head_only);
      return;
    }
    my @own = grep { ($_->{userId} || '') eq ($user->{id} || '') && ($_->{status} || '') ne 'removed' } listings();
    @own = sort { ($b->{createdAt} || '') cmp ($a->{createdAt} || '') } @own;
    respond_json($sock, 200, {
      user         => public_user($user, $viewer),
      stats        => {
        listings => scalar @own,
        lost     => scalar(grep { ($_->{type} || '') eq 'lost' } @own),
        found    => scalar(grep { ($_->{type} || '') eq 'found' } @own),
        returned => scalar(grep { ($_->{status} || '') eq 'returned' } @own),
      },
      achievements => achievements_for($user),
      listings     => [ map { listing_dto($_, $viewer) } @own ],
    }, $head_only);
    return;
  }

  if ($path eq '/api/messages') {
    respond_json($sock, 200, {
      items  => conversations_for($viewer),
      unread => unread_count($viewer),
    }, $head_only);
    return;
  }

  if ($path =~ m{^/api/conversations/([^/]+)$}) {
    my $id = urldecode($1);
    my ($conv) = grep { ($_->{id} || '') eq $id } @{ $DB->{conversations} || [] };
    my @members = $conv ? @{ $conv->{memberIds} || [] } : ();
    if (!$conv || !grep { $_ eq ($viewer->{id} || '') } @members) {
      respond_json($sock, 404, { error => 'That conversation could not be found.' }, $head_only);
      return;
    }
    my ($other_id) = grep { $_ ne ($viewer->{id} || '') } @members;
    my $other = user_by_id($other_id);
    my $listing = listing_by_id($conv->{listingId});
    my @msgs = grep { ($_->{conversationId} || '') eq $id } @{ $DB->{messages} || [] };
    @msgs = sort { ($a->{createdAt} || '') cmp ($b->{createdAt} || '') } @msgs;
    respond_json($sock, 200, {
      id     => $id,
      other  => $other ? {
        username  => $other->{username},
        fullName  => $other->{fullName},
        city      => defined $other->{city} ? $other->{city} : '',
        avatarUrl => $other->{avatarUrl},
      } : undef,
      listingDetail => $listing ? listing_dto($listing, $viewer) : undef,
      messages => [ map {
        {
          id        => $_->{id},
          body      => $_->{body},
          createdAt => $_->{createdAt},
          mine      => (($_->{senderId} || '') eq ($viewer->{id} || '') ? \1 : \0),
        }
      } @msgs ],
      listing => $listing ? { id => $listing->{id}, title => $listing->{title} } : undef,
    }, $head_only);
    return;
  }

  if (defined $viewer && $path eq '/api/notifications/read') {
    respond_json($sock, 200, { unread => unread_count($viewer), ok => \1 }, $head_only);
    return;
  }

  if (!$is_get) {
    respond_json($sock, 405, { error => $READ_ONLY }, $head_only);
    return;
  }

  # Signed-in surfaces have no data in this preview mode.
  respond_json($sock, 200, {
    items         => [],
    listings      => [],
    results       => [],
    users         => [],
    leaders       => [],
    entries       => [],
    matches       => [],
    conversations => [],
    messages      => [],
    notifications => [],
    saved         => [],
    reports       => [],
    categories    => [],
    cities        => [],
    total         => 0,
    hasMore       => \0,
    unread        => 0,
    ok            => \1,
  }, $head_only);
}

sub handle_request {
  my ($sock, $head, $body) = @_;
  my ($request_line) = split /\r\n/, $head;
  my ($method, $target) = split /\s+/, ($request_line || '');
  $method = 'GET' unless defined $method;
  $target = '/' unless defined $target && length $target;
  $method = uc $method;

  my ($raw_path, $raw_query) = split /\?/, $target, 2;
  my $path = urldecode($raw_path || '/');
  $path =~ s{/+$}{} if length($path) > 1;
  $path = '/' if $path eq '';
  my $head_only = ($method eq 'HEAD') ? 1 : 0;

  my %params;
  if (defined $raw_query && length $raw_query) {
    for my $pair (split /&/, $raw_query) {
      my ($key, $value) = split /=/, $pair, 2;
      next unless defined $key && length $key;
      $params{ urldecode($key) } = urldecode(defined $value ? $value : '');
    }
  }

  if ($path =~ m{^/api/}) {
    handle_api($sock, $method, $path, \%params, $head, $body, $head_only);
    return;
  }

  if ($path eq '/health') {
    respond_json($sock, 200, { ok => \1 }, $head_only);
    return;
  }

  if (($method ne 'GET' && $method ne 'HEAD') || $path =~ /\.\./) {
    respond($sock, 403, 'text/plain; charset=utf-8', 'Forbidden.', $head_only);
    return;
  }

  if ($path eq '/favicon.svg' || $path eq '/favicon.ico') {
    send_file($sock, "$PUBLIC/favicon.svg", $head_only);
    return;
  }

  if ($path =~ m{^/(css|js|uploads|assets)/}) {
    send_file($sock, "$PUBLIC$path", $head_only);
    return;
  }

  if (my $page = $PAGES{$path}) {
    send_file($sock, "$PUBLIC/$page", $head_only);
    return;
  }

  for my $entry (@DYNAMIC) {
    my ($pattern, $file) = @$entry;
    next unless $path =~ $pattern;
    send_file($sock, "$PUBLIC/$file", $head_only);
    return;
  }

  my $body_404 = 'Page not found.';
  if (open my $fh, '<:raw', "$PUBLIC/404.html") {
    local $/;
    $body_404 = <$fh>;
    close $fh;
  }
  respond($sock, 404, 'text/html; charset=utf-8', $body_404, $head_only);
}

my $listen = IO::Socket::INET->new(
  LocalAddr => '127.0.0.1',
  LocalPort => $PORT,
  Proto     => 'tcp',
  Listen    => 64,
  ReuseAddr => 1,
) or die "Could not listen on port $PORT: $!\n";

$listen->blocking(0);
my $select = IO::Select->new($listen);
my (%buffers, %opened);

$| = 1;
print "Lost N Found preview (member sign-in enabled, read-only data)\n";
print "PID $$\n";
print "Listening on http://127.0.0.1:$PORT\n";

while (1) {
  for my $sock ($select->can_read(0.5)) {
    if ($sock == $listen) {
      while (my $client = $listen->accept) {
        $client->blocking(0);
        $select->add($client);
        $buffers{ fileno $client } = '';
        $opened{ fileno $client } = time;
      }
      next;
    }

    my $fd = fileno $sock;
    unless (defined $fd) { $select->remove($sock); next; }

    my $chunk = '';
    my $read = sysread($sock, $chunk, 65536);
    if (!defined $read || $read == 0) {
      $select->remove($sock);
      close $sock;
      delete $buffers{$fd};
      delete $opened{$fd};
      next;
    }

    $buffers{$fd} .= $chunk;
    my $split_at = index($buffers{$fd}, "\r\n\r\n");
    if ($split_at >= 0) {
      my $head = substr($buffers{$fd}, 0, $split_at);
      my $length = 0;
      $length = $1 if $head =~ /^Content-Length:\s*(\d+)/mi;
      my $available = length($buffers{$fd}) - $split_at - 4;

      if ($available < $length) {
        if ($length > 262144) {
          respond_json($sock, 400, { error => 'Request body too large.' });
          $select->remove($sock);
          close $sock;
          delete $buffers{$fd};
          delete $opened{$fd};
        }
        next;   # wait for the rest of the body
      }

      my $body = $length ? substr($buffers{$fd}, $split_at + 4, $length) : '';
      $sock->blocking(1);
      eval { handle_request($sock, $head, $body) };
      warn "[request] $@" if $@;
      $select->remove($sock);
      close $sock;
      delete $buffers{$fd};
      delete $opened{$fd};
    } elsif (length($buffers{$fd}) > 65536) {
      $select->remove($sock);
      close $sock;
      delete $buffers{$fd};
      delete $opened{$fd};
    }
  }

  my $now = time;
  for my $sock ($select->handles) {
    next if $sock == $listen;
    my $fd = fileno $sock;
    next unless defined $fd;
    if ($now - ($opened{$fd} || $now) > 20) {
      $select->remove($sock);
      close $sock;
      delete $buffers{$fd};
      delete $opened{$fd};
    }
  }
}
