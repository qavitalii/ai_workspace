export function resourceBytes(n: number) {
  if (n < 1024 ** 2)
    return n >= 1024 ? `${(n / 1024).toFixed(1)} KiB` : `${n} B`;
  const unit = n >= 1024 ** 4 ? "TiB" : n >= 1024 ** 3 ? "GiB" : "MiB";
  const size =
    unit === "TiB" ? 1024 ** 4 : unit === "GiB" ? 1024 ** 3 : 1024 ** 2;
  return `${(n / size).toFixed(1)} ${unit}`;
}

export function Metric({
  label,
  value,
  detail,
  percent,
}: {
  label: string;
  value: string;
  detail: string;
  percent?: number | null;
}) {
  return (
    <div className="resource-card">
      <span>{label}</span>
      <strong>{value}</strong>
      {typeof percent === "number" && (
        <progress aria-label={label + " usage"} value={percent} max={100} />
      )}
      <small>{detail}</small>
    </div>
  );
}
