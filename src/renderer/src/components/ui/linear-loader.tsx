import { cn } from "@renderer/lib/utils";

export function LinearLoader({ className }: { className?: string }) {
  return (
    <div className={cn("relative h-0.5 w-full overflow-hidden rounded-full bg-muted", className)}>
      <div className="wa-linear-loader-slide absolute inset-y-0 left-0 w-1/3 rounded-full bg-accent" />
    </div>
  );
}

export function Skeleton({ className }: { className?: string }) {
  return <div className={cn("rounded-md bg-muted motion-safe:animate-pulse", className)} />;
}
