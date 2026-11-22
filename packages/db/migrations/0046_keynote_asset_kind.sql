-- A published snapshot can hold different bytes from the draft.
UPDATE assets SET kind = 'document'
WHERE kind = 'other' AND lower(trim(mime)) IN (
  'application/vnd.apple.keynote', 'application/x-iwork-keynote-sffkey'
);

UPDATE asset_published SET kind = 'document'
WHERE kind = 'other' AND lower(trim(
  substr(json_extract(file, '$.contentType'), 1, instr(json_extract(file, '$.contentType') || ';', ';') - 1)
)) IN ('application/vnd.apple.keynote', 'application/x-iwork-keynote-sffkey');
