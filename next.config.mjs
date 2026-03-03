/** @type {import('next').NextConfig} */
const nextConfig = {
    // Standalone output for optimized Docker builds
    output: 'standalone',
    // Disable Image Optimization (not needed for API-only)
    images: {
        unoptimized: true,
    },
    // CORS headers for API consumption
    async headers() {
        return [
            {
                source: '/api/:path*',
                headers: [
                    { key: 'Access-Control-Allow-Origin', value: '*' },
                    { key: 'Access-Control-Allow-Methods', value: 'GET, POST, PUT, PATCH, DELETE, OPTIONS' },
                    { key: 'Access-Control-Allow-Headers', value: 'Content-Type, Authorization, X-Requested-With' },
                    { key: 'Access-Control-Max-Age', value: '86400' },
                ],
            },
        ];
    },
};

export default nextConfig;
