import type { Metadata } from "next";
import "./globals.css";
export const metadata: Metadata = {
  title: "CloudCLI — Your cloud command centre",
  description: "A browser terminal for cloud operations, code generation and isolated command execution."
};
export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en"><body>{children}</body></html>;
}
