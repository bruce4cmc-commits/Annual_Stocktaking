# Annual Stocktaking V1.4 – Barcode Scanner Update

## Scope
- Adds browser-camera barcode decoding for Code 128 (linear barcode) and QR Code through `@zxing/browser` 0.1.5 UMD CDN.
- Uses the phone rear camera where available.
- Linear barcode text is used as the material query key directly.
- QR payloads beginning with `[)> 06 P` extract the value immediately following `P` up to the next whitespace/terminator. For the supplied sample this yields `MK580528` (PART No.).
- Successful decoding fills the existing keyword field and invokes the existing `search_inventory` flow.
- Stops camera tracks after success, on manual stop, and on page hide.
- No database schema, RPC, Edge Function, authentication, or inventory replacement changes.

## Deployment
1. Replace the Vercel project files with the five frontend files in this package: `index.html`, `app.js`, `styles.css`, `config.js` (retain the existing project values).
2. Ensure the browser can load `https://cdn.jsdelivr.net/npm/@zxing/browser@0.1.5/umd/index.min.js`.
3. Deploy to Vercel. Camera access requires HTTPS and user permission.
4. Test on a physical mobile device, not only desktop emulation.

## Important validation
- The supplied QR sample's prefix ` [)> 06 PMK580528` is parsed as PART No. `MK580528`.
- The sample linear barcode is expected to return the printed material number (e.g. `CW778818`) directly. Confirm this with a real scan.
- Camera decode has not been physically tested in the user's phone/browser in this package build. Complete the test matrix below before production sign-off.

## Acceptance tests
1. Scan the one-dimensional part-number barcode: decoded value should populate the keyword and trigger inventory search.
2. Scan the QR label: parsed PART No. should be `MK580528`, not LOT No. `0026`, C/S No. `052`, or quantity `30`.
3. Manual stop closes camera and releases camera tracks.
4. Deny camera permission: readable error appears; manual input remains available.
5. CDN unavailable: scanner reports component load failure; manual input remains available.
6. Search result is consistent with manually entering the same part number.
