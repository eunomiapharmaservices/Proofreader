/** @type {import('next').NextConfig} */
const nextConfig = {
  // Required for pdfjs-dist worker
  webpack: (config) => {
    config.resolve.alias.canvas = false;
    return config;
  },
};

module.exports = nextConfig;
