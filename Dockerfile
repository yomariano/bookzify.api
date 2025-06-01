# Use Node.js 20 as the base image
FROM node:20-slim

# Install required dependencies for Playwright
RUN apt-get update && apt-get install -y \
    wget \
    gnupg \
    libglib2.0-0 \
    libnss3 \
    libnspr4 \
    libatk1.0-0 \
    libatk-bridge2.0-0 \
    libcups2 \
    libdrm2 \
    libdbus-1-3 \
    libxcb1 \
    libxkbcommon0 \
    libx11-6 \
    libxcomposite1 \
    libxdamage1 \
    libxext6 \
    libxfixes3 \
    libxrandr2 \
    libgbm1 \
    libpango-1.0-0 \
    libcairo2 \
    libasound2 \
    && rm -rf /var/lib/apt/lists/*

# Create app directory
WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm install

# Copy source code
COPY . .

# Install Playwright browser
RUN npx playwright install --with-deps chromium

# Create a custom entrypoint script
RUN echo '#!/bin/bash\n\
# Wait for network services to be ready\n\
echo "Waiting for Supabase services..."\n\
timeout 30 bash -c "until ping -c 1 supabase-kong > /dev/null 2>&1; do sleep 2; done"\n\
timeout 30 bash -c "until ping -c 1 supabase-db > /dev/null 2>&1; do sleep 2; done"\n\
\n\
# Start the application\n\
exec node index.js' > /app/docker-entrypoint.sh \
    && chmod +x /app/docker-entrypoint.sh

# Set the entrypoint
ENTRYPOINT ["/app/docker-entrypoint.sh"]

# Expose port
EXPOSE 5005 