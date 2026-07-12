"use client";

import { useParams } from "next/navigation";

import { ProfileStats } from "@/components/ProfileStats";

export default function PlayerPage() {
  const address = String(useParams().address).toLowerCase();
  return (
    <div className="container">
      <ProfileStats address={address} />
    </div>
  );
}
