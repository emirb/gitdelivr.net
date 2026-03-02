#!/usr/bin/env bash
set -euo pipefail

version="${1:-system}"

have_cmd() {
  command -v "$1" >/dev/null 2>&1
}

install_packages() {
  if have_cmd apk; then
    apk add --no-cache "$@"
    return
  fi

  if have_cmd apt-get; then
    apt-get update
    apt-get install -y --no-install-recommends "$@"
    return
  fi

  echo "Unsupported package manager" >&2
  exit 1
}

if [ "$version" = "system" ]; then
  if have_cmd git && have_cmd git-lfs; then
    exit 0
  fi
  install_packages git git-lfs
  exit 0
fi

if have_cmd apk; then
  install_packages \
    autoconf \
    build-base \
    curl \
    curl-dev \
    expat-dev \
    git-lfs \
    make \
    ncurses-dev \
    openssl-dev \
    perl \
    perl-error \
    zlib-dev
elif have_cmd apt-get; then
  install_packages \
    autoconf \
    build-essential \
    curl \
    libcurl4-openssl-dev \
    libexpat1-dev \
    git-lfs \
    libncurses-dev \
    libssl-dev \
    make \
    perl \
    zlib1g-dev
else
  echo "Unsupported package manager" >&2
  exit 1
fi

workdir="$(mktemp -d)"
trap 'rm -rf "$workdir"' EXIT

archive="git-${version}.tar.gz"
url="https://mirrors.edge.kernel.org/pub/software/scm/git/${archive}"

curl -fsSL "$url" -o "$workdir/$archive"
tar -xzf "$workdir/$archive" -C "$workdir"

cd "$workdir/git-$version"
make configure
./configure --prefix=/usr/local
make -j"$(getconf _NPROCESSORS_ONLN)" \
  NO_GETTEXT=YesPlease \
  NO_TCLTK=YesPlease \
  NO_INSTALL_HARDLINKS=YesPlease
make install \
  NO_GETTEXT=YesPlease \
  NO_TCLTK=YesPlease \
  NO_INSTALL_HARDLINKS=YesPlease
