#!/bin/bash

# Exit immediately if a command exits with a non-zero status.
set -e

# Install Playwright browser dependencies
echo "Installing Playwright browser dependencies..."
npx playwright install --with-deps chromium

# Install project dependencies
echo "Installing project dependencies..."
npm install

# Start the server
echo "Starting the server..."
node index.js

echo "Server setup complete and running." 