import { Scan, Play } from "lucide-react";

export function Brand() {
  return <div className="brand">
    <span className="brand-mark" aria-hidden="true"><Scan size={25} /><Play size={10} fill="currentColor" /></span>
    <span><strong>Кадр</strong><small>Исследование видео</small></span>
  </div>;
}
