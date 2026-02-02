export function buildMoneroUri(opts: {
  address: string;
  amount?: string | undefined; // keep as string to avoid float issues
  description?: string | undefined;
}): string {
  const params = new URLSearchParams();
  if (opts.amount) params.set("tx_amount", opts.amount);
  if (opts.description) params.set("tx_description", opts.description);

  const qs = params.toString();
  return qs ? `monero:${opts.address}?${qs}` : `monero:${opts.address}`;
}
