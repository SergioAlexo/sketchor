# Pallet Size Generator

Open **Pallet Size Generator** beside **Truck Load Planner** in Sketchor's toolbar. The command is also available in the plugin command palette.

1. Enter the job number, product, quantity and footprint. Set **Max pallet length**, **Max pallet width** and **Max layers** at the top. The reference profile uses a 96 in width cap, 1 in from the edge, 1 in between products, and one job per pallet. The starting 120 in length is an editable example. **Use reference width and gaps** restores the reference width and clearances.
2. For a product approved for stacking, set **Stack up to** to two or three layers. Choose **Alternate upside down** for upright, upside down, upright. The planner aligns matching products from the same row. To apply a **Max loaded height**, enter deck height, item height, and the measured added height per layer for a nested alternating stack. If both nominal and measured dimensions are available, select **Use measured footprint**. The planner uses the larger value on each axis.
3. Select **Generate pallets**. The planner tries rectangular layouts with the allowed turns, then ranks them by units placed, pallet count and total base area. It lists any unplaced products and the reason.
4. Choose a pallet and a layer. Upside-down units are marked **↓**. Dragging moves the aligned stack together. Change a unit's pallet, destination layer, rotation or coordinates in the position editor. Upper layers require a matching unit directly below. **Open drawing** shows a separate 2D diagram for each layer.
5. Confirm the plan once all products are placed. **Save JSON** keeps that revision and **Open JSON** reopens it. **Save loading report** downloads a printable HTML document with layer diagrams and loading positions. **Export analysis CSV** downloads one row per product unit with the generated and final assignments side by side.

For a walkthrough, select **Load 7-bench example**. The example uses 30 × 15 in product footprints and a 32 × 49 in pallet limit. With a two-layer cap, six units share the 32 × 49 in base and the seventh uses a 32 × 17 in base. Change **Max layers** to three and generate again to put the seventh on the third layer of the first pallet.

The preview and report use the plan's rectangular footprints and configured layer pattern. Confirm the product's stacking arrangement before loading.

## JSON format and truck handoff

Schema version 2 stores dimensions and coordinates in millimetres. Product placement uses the lower-left corner of its turned footprint. Rotation is 0° or 90°. Version 1 files reopen with their existing placements on layer 1.

| Record | Fields |
| --- | --- |
| Plan | `schemaVersion`, `id`, `revisionId`, `parentRevisionId`, `review`, `products`, `rules`, `pallets`, `unplaced`, and optional `generation` |
| Product row | `id`, `jobId`, `productId`, `quantity`, `lengthMm`, `widthMm`, `canRotate`. Optional height, weight, notes, stacking rules, source row ID and source unit. |
| Pallet | `id`, `jobId`, `base`, `loadedFootprint`, `baseSource`, `placements`, `truckOrientation`. Optional base name, handling tag, packed height and gross weight. |
| Placement | Product unit `id`, `rowId`, `xMm`, `yMm`, `rotation`, `layer` |
| Unplaced product | Product unit `id`, `rowId` and `reason` |

The loaded footprint equals the base. The plan parser checks quantity, IDs, job membership, rotation, layer support, clearances and configured height. A confirmed revision accounts for every product and contains a product on each pallet.

New plans retain the solver ID and original generated layout through manual edits. The CSV includes the plan and revision IDs, rules, product dimensions, unit ID, pallet, layer, orientation, coordinates and supporting unit. Use `changed_since_generation` to find product assignments affected by a manual edit. Join revisions by `plan_id`, `revision_id` and `unit_id`. Version 1 files have blank generated fields when their original solve is unavailable. Keep the JSON alongside the CSV for the full stock-base profile and plan history reference.

`toTruckOrders(plan, stops)` maps a confirmed revision to the current truck engine's `Order[]`. Supply one stop mapping per job in load order. The adapter carries each pallet's length and width in mm, stable ID, orientation and handling tag. The test for the two-carton plan passes an 82 × 39 in pallet into the existing truck engine and validates the result. The next phase connects this adapter to the Truck Load Planner panel.

## Verification

`npm test` covers the packing rules, revisions, JSON validation and truck handoff. `npm run build` checks the production build. To try the panel, use `npm run dev` for the browser or `npm run desktop` with the Tauri prerequisites installed.

The initial single-layer version was also benchmarked in headless Chrome on Windows from action to rendered update. These timings use 20 samples after two warmups.

| Action | Fixture | Median | 95th percentile |
| --- | --- | --- | --- |
| Generate pallets | 100 synthetic 80 × 18 in cartons | 33 ms | 34 ms |
| Apply pallet edit | Base resize on the 100-carton plan | 33 ms | 34 ms |
| Truck Load Planner baseline | 100 of the default 48 × 42 in pallets | 33 ms | 34 ms |

The browser walkthrough covered generation, a rejected overlap, drag, undo and redo, JSON export and reopen, and the drawing snapshot. Native Tauri timing is pending because the verification machine lacks Cargo.
