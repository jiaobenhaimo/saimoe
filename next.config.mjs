/** @type {import('next').NextConfig} */
const nextConfig = {
  // Emit a self-contained server bundle (.next/standalone) that ships only the
  // production deps Next traces — no devDependencies in the runtime image.
  output: "standalone",
};
export default nextConfig;
