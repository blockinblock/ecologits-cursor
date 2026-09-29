// Copied from marmelab/ecologits-vscode (MIT). Auto-scaling formatters
// that match the ecologits-statusline display conventions.

export function fmtGwp(v: number): string {
  if (!v || v <= 0) return '0';
  if (v >= 1)       return `${v.toFixed(2)} kgCO₂eq`;
  if (v >= 0.001)   { const g = v * 1000; return `${g >= 10 ? g.toFixed(0) : g.toFixed(1)} gCO₂eq`; }
  return `${(v * 1e6).toFixed(0)} mgCO₂eq`;
}

export function fmtWcf(v: number): string {
  if (!v || v <= 0) return '0';
  if (v >= 1)       return `${v.toFixed(2)} L`;
  const ml = v * 1000;
  if (ml >= 10) return `${ml.toFixed(0)} mL`;
  if (ml >= 1)  return `${ml.toFixed(1)} mL`;
  return `${ml.toFixed(2)} mL`;
}

export function fmtEnergy(v: number): string {
  if (!v || v <= 0) return '0';
  if (v >= 1)       return `${v.toFixed(2)} kWh`;
  const wh = v * 1000;
  if (wh >= 10) return `${wh.toFixed(0)} Wh`;
  if (wh >= 1)  return `${wh.toFixed(1)} Wh`;
  return `${(v * 1e6).toFixed(0)} mWh`;
}

export function fmtAdpe(v: number): string {
  if (!v || v <= 0) return '0';
  if (v >= 1)        return `${v.toFixed(2)} kgSbeq`;
  if (v >= 0.001)    return `${(v * 1000).toFixed(1)} gSbeq`;
  const mg = v * 1e6;
  if (mg >= 10) return `${mg.toFixed(0)} mgSbeq`;
  if (mg >= 1)  return `${mg.toFixed(1)} mgSbeq`;
  return `${(v * 1e9).toFixed(0)} µgSbeq`;
}

export function fmtPe(v: number): string {
  if (!v || v <= 0) return '0';
  if (v >= 1)       return `${v.toFixed(2)} MJ`;
  if (v >= 0.001)   { const kj = v * 1000; return `${kj >= 10 ? kj.toFixed(0) : kj.toFixed(1)} kJ`; }
  return `${(v * 1e6).toFixed(0)} J`;
}
