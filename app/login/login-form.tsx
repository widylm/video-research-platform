"use client";

import { useActionState } from "react";
import { ArrowRight } from "lucide-react";
import { signIn } from "@/app/actions";

export function LoginForm() {
  const [error, submit, pending] = useActionState(signIn, "");

  return <form className="login-form" action={submit}>
    <label>Электронная почта<input required name="email" type="email" autoComplete="username" /></label>
    <label>Пароль<input required name="password" type="password" autoComplete="current-password" /></label>
    {error && <p className="notice error" role="alert">{error}</p>}
    <button className="button primary" disabled={pending}>
      {pending ? "Входим…" : "Войти"} <ArrowRight size={17} />
    </button>
  </form>;
}
