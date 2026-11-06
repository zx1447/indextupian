#!/bin/sh
mkdir -p /app
tar -xzf /downloads/pack.tar.gz -C /app
sh /app/boot.sh
