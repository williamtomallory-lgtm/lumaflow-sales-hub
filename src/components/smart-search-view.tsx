"use client";

import type { Product } from "@/lib/catalog";
import { AgentWorkspace } from "./agent-workspace";

/** Compatibility entry for callers; both search and sales use one Chat-AI UI. */
export function SmartSearchView({ products, initialQuestion, onProduct, onToast, onAddToKit }: {
  products: Product[];
  initialQuestion: string;
  onProduct: (product: Product) => void;
  onToast: (message: string) => void;
  onAddToKit: (id: string) => void;
}) {
  return <AgentWorkspace products={products} assets={[]} customers={[]} initialExperience="chat" initialMessage={initialQuestion} onOpenProduct={onProduct} onToast={onToast} onAddToKit={onAddToKit} />;
}
