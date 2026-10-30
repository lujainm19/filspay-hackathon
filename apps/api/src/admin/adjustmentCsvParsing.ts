import { parseBhdToFils, type Fils } from "@filspay/money";
import { BadRequestError } from "../lib/errors.js";

/**
 * Parses one CSV row's amount column (BD, as finance types it) into fils.
 *
 * M1 fix: what was wrong — this used parseDecimalMinor(raw), which defaults to
 * TWO decimal places ("cents"). Why — someone assumed BD works like dollars,
 * but 1 BD = 1000 fils (ADR-0001). What it broke — "4.75" became 475 fils
 * (0.475 BD, ten times too little) and "4.755" lost its last digit; Huda's
 * 4,141.90 BD sheet posted 414.190 BD. parseBhdToFils is the shared,
 * three-decimal parser: "4.75" and "4.750" are both 4750 fils, and a fourth
 * decimal or any junk is rejected instead of silently cut off.
 */
export function parseAdjustmentAmountFils(raw: string): Fils {
  try {
    return parseBhdToFils(raw);
  } catch {
    throw new BadRequestError("invalid_amount", `could not parse amount "${raw}"`);
  }
}

export interface ParsedAdjustmentCsvRow {
  merchantId: string;
  amount: string;
  reason?: string;
}

/**
 * Splits the uploaded CSV text into rows. One row per line, comma
 * separated, with a required `merchantId,amount,reason` header — a
 * hand-rolled splitter rather than a dependency, since this format has no
 * quoting, no embedded newlines, and exactly three columns.
 */
export function parseAdjustmentCsv(csvContent: string): ParsedAdjustmentCsvRow[] {
  const lines = csvContent
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "");

  if (lines.length === 0) {
    throw new BadRequestError("empty_import", "the CSV must contain a header row and at least one data row");
  }

  const header = (lines[0] as string).split(",").map((cell) => cell.trim().toLowerCase());
  if (header[0] !== "merchantid" || header[1] !== "amount") {
    throw new BadRequestError("invalid_csv_header", "the CSV header must be merchantId,amount,reason");
  }

  const rows: ParsedAdjustmentCsvRow[] = [];
  for (let i = 1; i < lines.length; i++) {
    const cells = (lines[i] as string).split(",").map((cell) => cell.trim());
    const merchantId = cells[0] ?? "";
    const amount = cells[1] ?? "";
    if (merchantId === "" || amount === "") {
      throw new BadRequestError("invalid_csv_row", `row ${i} is missing a merchantId or an amount`);
    }
    const reason = cells[2];
    rows.push(reason === undefined || reason === "" ? { merchantId, amount } : { merchantId, amount, reason });
  }

  if (rows.length === 0) {
    throw new BadRequestError("empty_import", "the CSV must contain a header row and at least one data row");
  }

  return rows;
}
