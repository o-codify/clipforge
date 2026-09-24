import { PageSkeleton } from "@/components/ui";

/** Route loading stays inside the persistent workspace shell. */
export default function Loading() {
  return <div role="status" aria-label="Загрузка раздела"><PageSkeleton /></div>;
}
