"use client";
import dynamic from "next/dynamic";

const WebContainerRunner = dynamic(
  () => import("@/components/webcontainer-runner").then(mod => mod.WebContainerRunner),
  { ssr: false }
);

export default function WebcontainerClient() {
  return <WebContainerRunner />;
}