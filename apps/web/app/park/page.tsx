import { redirect } from "next/navigation";

// The park lobby is the home page's main surface; this legacy route (and its
// jargon "Park / Patzer" title) duplicated it. Redirect to home so there's one
// canonical lobby.
export default function ParkPage() {
  redirect("/");
}
