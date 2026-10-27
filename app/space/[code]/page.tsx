import type { Metadata } from "next";
import { SpaceClient } from "@/src/components/space-client";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export const metadata: Metadata = {
  title: "Shared space — Numa",
  robots: { index: false, follow: false, noarchive: true },
  referrer: "no-referrer",
};

export default async function SpacePage({
  params,
}: {
  params: Promise<{ code: string }>;
}) {
  const { code } = await params;
  return <SpaceClient code={code} />;
}
