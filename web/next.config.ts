import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  experimental: {
    // Server Actions default to a 1MB request body, which a card photo
    // (phone camera JPEG, PSA slab scan) blows past easily. addBuyingListItem
    // uploads the image through the "Add card" modal's server action, so it
    // needs headroom. 10mb covers a realistic phone photo with margin.
    serverActions: {
      bodySizeLimit: "10mb",
    },
  },
};

export default nextConfig;
