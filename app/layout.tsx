import type { Metadata, Viewport } from "next";
import { ServiceWorkerRegister } from "./components/service-worker-register";
import "./globals.css";

export const metadata: Metadata = {
  title: "Needle & Frame",
  description: "An art-first television experience for music listening.",
  applicationName: "Needle & Frame",
  appleWebApp: {
    capable: true,
    statusBarStyle: "black-translucent",
    title: "Needle & Frame",
  },
  icons: {
    icon: [
      { url: "/icon-192.png", sizes: "192x192", type: "image/png" },
      { url: "/icon-512.png", sizes: "512x512", type: "image/png" },
    ],
    apple: [{ url: "/apple-touch-icon.png", sizes: "180x180", type: "image/png" }],
  },
};

export const viewport: Viewport = {
  themeColor: "#171410",
  colorScheme: "dark",
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>
        {children}
        <ServiceWorkerRegister />
      </body>
    </html>
  );
}
