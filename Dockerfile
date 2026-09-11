FROM node:22-slim

WORKDIR /app

# Fonts for the rasterised catalog cards. The card SVGs are rendered to JPEG
# server-side because Nuvio does not draw SVG posters, and a container with no
# fonts renders every label as nothing at all — silently, with the artwork
# otherwise intact.
RUN apt-get update \
 && apt-get install -y --no-install-recommends fonts-dejavu-core fontconfig \
 && fc-cache -f \
 && rm -rf /var/lib/apt/lists/*

# Copy package configs and install dependencies
COPY package*.json ./
RUN npm install

# Copy source code and assets
COPY . .

# Install internal resolver dependencies
RUN cd resolver && npm install

# Build the bundled distribution
RUN npm run build

# Configure runtime environment
ENV PORT=7000
ENV NODE_ENV=production
EXPOSE 7000

# Start server directly with node
CMD ["node", "dist/index.js"]

