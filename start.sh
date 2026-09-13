#!/bin/bash

# Check if Node.js is installed
if ! command -v node &> /dev/null
then
    echo "[ERROR] Node.js is not installed!"
    echo "Please download and install Node.js from https://nodejs.org/"
    exit 1
fi

echo "[AIOSports] Installing dependencies if needed..."
npm install

echo ""
echo "[AIOSports] Starting the server..."
npm start
