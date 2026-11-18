import type { Metadata } from "next";
import "@fontsource-variable/manrope";
import "./globals.css";

export const metadata: Metadata = {
  title: "Кадр — исследование видео",
  description: "Рабочее пространство для исследования коротких видео.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="ru"><body>{children}</body></html>;
}
