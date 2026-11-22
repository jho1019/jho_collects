"use client";

import { useState, useTransition } from "react";
import { setReleasePurchase } from "@/app/(app)/releases/actions";

// "Did I get it" checkbox plus a quantity, saved to the releases row. Checking
// the box saves immediately; the quantity saves on blur / Enter.
export default function ReleasePurchase({
  releaseId,
  initialPurchased,
  initialQuantity,
}: {
  releaseId: number;
  initialPurchased: boolean;
  initialQuantity: number | null;
}) {
  const [purchased, setPurchased] = useState(initialPurchased);
  const [quantity, setQuantity] = useState(initialQuantity == null ? "" : String(initialQuantity));
  const [savedQty, setSavedQty] = useState(initialQuantity == null ? "" : String(initialQuantity));
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function save(nextPurchased: boolean, nextQty: string) {
    const qty = nextQty.trim() === "" ? null : Number(nextQty);
    startTransition(async () => {
      const res = await setReleasePurchase(releaseId, nextPurchased, qty);
      if (res.error) {
        setError(res.error);
        setPurchased(initialPurchased);
      } else {
        setError(null);
        setSavedQty(nextPurchased ? nextQty : "");
      }
    });
  }

  return (
    <div className="flex items-center gap-2">
      <input
        type="checkbox"
        checked={purchased}
        disabled={pending}
        aria-label="Purchased"
        onChange={(e) => {
          const next = e.target.checked;
          setPurchased(next);
          if (!next) setQuantity("");
          save(next, next ? quantity : "");
        }}
        className="chk"
      />
      {purchased && (
        <input
          type="number"
          min={1}
          step={1}
          inputMode="numeric"
          value={quantity}
          disabled={pending}
          placeholder="Qty"
          aria-label="Quantity purchased"
          onChange={(e) => setQuantity(e.target.value)}
          onBlur={() => {
            if (quantity !== savedQty) save(true, quantity);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") e.currentTarget.blur();
          }}
          className="field r w-16 !px-2 !py-1"
        />
      )}
      {error && <span className="text-[11.5px] text-neg">{error}</span>}
    </div>
  );
}
