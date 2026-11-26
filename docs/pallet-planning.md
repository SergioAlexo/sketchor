# Pallet Size Generator

Open **Pallet Size Generator** beside **Truck Load Planner** in Sketchor's toolbar. The command is also available in the plugin command palette.

1. Add products and quantities. Choose millimetres or inches and set the allowable base sizes, edge clearance and product gap. The starting profile uses an example 120 × 96 in cap, a 1 in clearance at each edge and 1 in between products. Edit the profile for your shop.
2. Select **Generate pallets**. The planner tries rectangular layouts with the allowed turns, then chooses among them by number of items placed, pallet count and total base area. Each pallet belongs to one job. The plan lists any unplaced products and the reason.
3. Choose a pallet. Drag a product in the preview or enter its coordinates. Use the destination selector to move a product to another pallet in the same job. You can also resize a base and set how the whole pallet can turn in the truck.
4. Confirm the plan once all products are placed. **Save JSON** keeps that revision and **Open JSON** reopens it. Sketchor restores the most recent working revision locally. Undo and redo cover edits in the current session.
5. **Open drawing** creates a new Sketchor tab with a drawing snapshot. Use the panel for edits that should appear in the plan JSON.

For a walkthrough, select **Load example** and generate. With the starting profile, the two cartons share an 82 × 39 in base. Try resizing the length to 86 in and moving a carton along X. Save the result, then reopen the JSON to check the edited dimensions and placement.

## JSON format and truck handoff

Schema version 1 stores dimensions and coordinates in millimetres. Product placement uses the lower-left corner of its turned footprint. Rotation is 0° or 90°.

| Record | Fields |
| --- | --- |
| Plan | `schemaVersion`, `id`, `revisionId`, `parentRevisionId`, `review`, `products`, `rules`, `pallets`, `unplaced` |
| Product row | `id`, `jobId`, `productId`, `quantity`, `lengthMm`, `widthMm`, `canRotate`. Optional height, weight, notes, source row ID and source unit. |
| Pallet | `id`, `jobId`, `base`, `loadedFootprint`, `baseSource`, `placements`, `truckOrientation`. Optional base name, handling tag, packed height and gross weight. |
| Placement | Product unit `id`, `rowId`, `xMm`, `yMm`, `rotation` |
| Unplaced product | Product unit `id`, `rowId` and `reason` |

Within this single-layer, within-base format, the loaded footprint equals the base. The plan parser checks quantity, IDs, job membership, rotation and geometry. A confirmed revision accounts for every product and contains a product on each pallet.

`toTruckOrders(plan, stops)` maps a confirmed revision to the current truck engine's `Order[]`. Supply one stop mapping per job in load order. The adapter carries each pallet's length and width in mm, stable ID, orientation and handling tag. The test for the two-carton plan passes an 82 × 39 in pallet into the existing truck engine and validates the result. The next phase connects this adapter to the Truck Load Planner panel.

## Verification

`npm test` covers the packing rules, revisions, JSON validation and truck handoff. `npm run build` checks the production build. To try the panel, use `npm run dev` for the browser or `npm run desktop` with the Tauri prerequisites installed.

A headless Chrome run on Windows measured the built application from action to rendered update. These timings use 20 samples after two warmups.

| Action | Fixture | Median | 95th percentile |
| --- | --- | --- | --- |
| Generate pallets | 100 synthetic 80 × 18 in cartons | 33 ms | 34 ms |
| Apply pallet edit | Base resize on the 100-carton plan | 33 ms | 34 ms |
| Truck Load Planner baseline | 100 of the default 48 × 42 in pallets | 33 ms | 34 ms |

The browser walkthrough covered generation, a rejected overlap, drag, undo and redo, JSON export and reopen, and the drawing snapshot. Native Tauri timing is pending because the verification machine lacks Cargo.
