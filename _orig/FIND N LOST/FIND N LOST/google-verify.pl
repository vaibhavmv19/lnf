#!/usr/bin/perl
# google-verify.pl — Google ID token verification for the preview host.
#
# Node's own verifier lives in server/google-auth.js; this is the same set of
# checks for serve-local.pl, which cannot use it. Signatures are checked with
# the openssl CLI, so no Perl crypto modules are required.
#
# Usage from serve-local.pl:
#   require "$ROOT/google-verify.pl";
#   my ($profile, $error) = GoogleVerify::verify(
#     jwt => $credential, client_id => $id, domain => 'mys.rvu.edu.in');
package GoogleVerify;

use strict;
use warnings;
use JSON::PP ();
use MIME::Base64 qw(encode_base64);
use File::Temp qw(tempdir);

my $JWKS_URL = $ENV{GOOGLE_JWKS_URL} || 'https://www.googleapis.com/oauth2/v3/certs';
my %CACHE;   # url => { keys => [...], expires_at => epoch }

sub _json { return JSON::PP->new->utf8 }

# --- base64url --------------------------------------------------------------

sub b64url_decode {
  my ($value) = @_;
  $value = '' unless defined $value;
  $value =~ tr{-_}{+/};
  $value .= '=' x ((4 - length($value) % 4) % 4);
  return MIME::Base64::decode_base64($value);
}

# --- DER/PEM ----------------------------------------------------------------

sub _der_len {
  my ($length) = @_;
  return chr($length) if $length < 128;
  my $bytes = '';
  while ($length > 0) {
    $bytes   = chr($length & 0xff) . $bytes;
    $length >>= 8;
  }
  return chr(0x80 | length($bytes)) . $bytes;
}

sub _der_int {
  my ($bytes) = @_;
  $bytes = "\0" . $bytes if length($bytes) && (ord(substr($bytes, 0, 1)) & 0x80);
  return "\x02" . _der_len(length $bytes) . $bytes;
}

# Build a SubjectPublicKeyInfo PEM from a JWK modulus/exponent.
sub pem_from_jwk {
  my ($n_b64, $e_b64) = @_;
  my $modulus = b64url_decode($n_b64);
  $modulus =~ s/^\0+//;
  my $exponent = b64url_decode($e_b64);
  return undef unless length $modulus && length $exponent;

  my $rsa = "\x30" . _der_len(length(_der_int($modulus) . _der_int($exponent)))
          . _der_int($modulus) . _der_int($exponent);

  my $algorithm = "\x30\x0d\x06\x09\x2a\x86\x48\x86\xf7\x0d\x01\x01\x01\x05\x00";   # rsaEncryption
  my $bitstring = "\x03" . _der_len(length($rsa) + 1) . "\0" . $rsa;
  my $spki      = "\x30" . _der_len(length($algorithm) + length($bitstring)) . $algorithm . $bitstring;

  my $encoded = encode_base64($spki, '');
  my $pem = "-----BEGIN PUBLIC KEY-----\n";
  $pem .= "$_\n" for ($encoded =~ /(.{1,64})/g);
  $pem .= "-----END PUBLIC KEY-----\n";
  return $pem;
}

# --- key fetching -----------------------------------------------------------

sub fetch_jwks {
  my ($url) = @_;
  $url = $JWKS_URL unless defined $url && length $url;
  my $cached = $CACHE{$url};
  return $cached->{keys} if $cached && time < $cached->{expires_at};

  my $raw = '';
  if (open my $fh, '-|', 'curl', '-s', '--max-time', '10', '-H', 'accept: application/json', $url) {
    local $/;
    $raw = <$fh> // '';
    close $fh;
  }
  my $parsed = eval { _json()->decode($raw) };
  return [] unless ref($parsed) eq 'HASH' && ref($parsed->{keys}) eq 'ARRAY';
  $CACHE{$url} = { keys => $parsed->{keys}, expires_at => time + 3600 };
  return $parsed->{keys};
}

# --- signature --------------------------------------------------------------

sub rsa_verify {
  my ($pem, $data, $signature) = @_;
  return 0 unless defined $pem && length $pem;
  my $dir = tempdir(CLEANUP => 1);
  my ($pem_file, $dat_file, $sig_file) = ("$dir/pub.pem", "$dir/data.bin", "$dir/sig.bin");
  for my $pair ([$pem_file, $pem], [$dat_file, $data], [$sig_file, $signature]) {
    open my $fh, '>:raw', $pair->[0] or return 0;
    print {$fh} $pair->[1];
    close $fh;
  }
  my $out = '';
  if (open my $fh, '-|', 'openssl', 'dgst', '-sha256', '-verify', $pem_file,
      '-signature', $sig_file, $dat_file) {
    local $/;
    $out = <$fh> // '';
    close $fh;
  }
  return $out =~ /Verified OK/ ? 1 : 0;
}

# --- public API -------------------------------------------------------------

sub verify {
  my (%args) = @_;
  my $jwt       = $args{jwt} || '';
  my $client_id = $args{client_id} || '';
  my $domain    = lc($args{domain} || '');
  return (undef, 'Google sign-in is not configured yet.') unless length $client_id;

  my @parts = split /\./, $jwt;
  return (undef, 'That Google credential is not valid. Please try again.') unless @parts == 3;
  my ($raw_header, $raw_payload, $raw_signature) = @parts;

  my $header  = eval { _json()->decode(b64url_decode($raw_header)) };
  my $payload = eval { _json()->decode(b64url_decode($raw_payload)) };
  return (undef, 'That Google credential is not valid. Please try again.')
    unless ref($header) eq 'HASH' && ref($payload) eq 'HASH';
  return (undef, 'That Google credential is not valid. Please try again.')
    unless ($header->{alg} || '') eq 'RS256' && length($header->{kid} || '');

  my $keys = $args{jwks} ? $args{jwks} : fetch_jwks($args{jwks_url});
  my ($jwk) = grep { ($_->{kid} || '') eq $header->{kid} } @{ $keys || [] };
  return (undef, 'Google could not verify this sign-in. Please try again.') unless $jwk;

  my $pem = pem_from_jwk($jwk->{n}, $jwk->{e});
  unless (rsa_verify($pem, "$raw_header.$raw_payload", b64url_decode($raw_signature))) {
    return (undef, 'Google could not verify this sign-in. Please try again.');
  }

  my $issuer = $payload->{iss} || '';
  unless ($issuer eq 'https://accounts.google.com' || $issuer eq 'accounts.google.com') {
    return (undef, 'That sign-in did not come from Google.');
  }

  my @audience = ref($payload->{aud}) eq 'ARRAY' ? @{ $payload->{aud} } : ($payload->{aud});
  unless (grep { defined $_ && $_ eq $client_id } @audience) {
    return (undef, 'That sign-in was issued for a different application.');
  }

  my $now = time;
  my $exp = $payload->{exp};
  return (undef, 'That sign-in has expired. Please try again.')
    unless defined $exp && $exp =~ /^\d+$/ && $exp >= $now - 60;
  my $iat = $payload->{iat};
  if (defined $iat && $iat =~ /^\d+$/ && $iat > $now + 300) {
    return (undef, 'That sign-in has a timestamp from the future.');
  }

  my $verified = $payload->{email_verified};
  return (undef, 'Your Google email address is not verified.')
    unless $verified && $verified ne 'false' && $verified ne '0';

  return (undef, 'That sign-in is missing the Google account id.') unless length($payload->{sub} || '');

  my $email = lc($payload->{email} || '');
  return (undef, "Only \@$domain accounts can sign in.")
    unless length $domain && $email =~ /\@\Q$domain\E$/;
  return (undef, "Only accounts managed by \@$domain can sign in.")
    unless lc($payload->{hd} || '') eq $domain;

  return ({
    sub     => $payload->{sub},
    email   => $email,
    name    => defined $payload->{name} ? $payload->{name} : '',
    picture => $payload->{picture},
    domain  => $domain,
  }, undef);
}

1;
