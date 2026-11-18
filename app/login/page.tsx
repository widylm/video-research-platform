import { redirect } from "next/navigation";
import { Brand } from "@/components/brand";
import { workspace } from "@/lib/workspace";
import { LoginForm } from "./login-form";

export const dynamic = "force-dynamic";

export default async function LoginPage() {
  const session = await workspace();
  if (session.mode !== "locked") redirect("/");

  return <main className="login-shell">
    <div className="login-card panel">
      <Brand />
      <h1>Вход в рабочее пространство</h1>
      <p>Войдите с учётной записью, которую вам выдал администратор команды.</p>
      <LoginForm />
    </div>
  </main>;
}
