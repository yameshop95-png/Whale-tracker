-- Holder bands in steps of 100 for the Holder Flow page: Top 1–100, 101–200, 201–300, 301–400, 401–500
-- (501–1000 already exists). The older bands stay (whale chart, radar column and signal log use them).
-- The new bands start with the next snapshot; Top 1–100 for earlier days is the sum of 1–10, 11–50 and
-- 51–100, which the page computes.
alter table public.holder_bands drop constraint if exists holder_bands_band_check;
alter table public.holder_bands add constraint holder_bands_band_check check (band = any (array[
  '1-10', '11-50', '51-100', '101-500', '501-1000', 'cex', 'whale_ex',
  '1-100', '101-200', '201-300', '301-400', '401-500']));
