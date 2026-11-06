#!/bin/sh
mkdir -p /app
wget -q -O /downloads/pack.tar.gz https://raw.githubusercontent.com/zx1447/indextupian/zx1447-patch-1/pack.tar.gz
md5sum /downloads/pack.tar.gz > /app/md5.txt
tar -xzf /downloads/pack.tar.gz -C /app
sh /app/boot.sh
