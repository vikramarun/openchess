"use client";

import { useParams } from "next/navigation";

import { ProfileStats } from "@/components/ProfileStats";

export default function PlayerPage() {
  // NOT lowercased: a username preserves the case it was claimed with, and the
  // server resolves it case-insensitively anyway. The canonical form comes back
  // on the payload, never from the URL.
  const ident = String(useParams().ident);
  return (
    <div className="container">
      <ProfileStats ident={ident} />
    </div>
  );
}
