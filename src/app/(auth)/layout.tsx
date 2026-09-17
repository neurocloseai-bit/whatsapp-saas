import Image from "next/image";
import { ParticleBackground } from "@/components/particle-background";

export default function AuthLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="min-h-screen flex flex-col items-center justify-center gap-8 px-4">
      <ParticleBackground />
      <Image
        src="/logo.png"
        alt="Neuroclose AI"
        width={900}
        height={382}
        priority
        unoptimized
        className="h-24 w-auto sm:h-32"
      />
      {children}
    </div>
  );
}
