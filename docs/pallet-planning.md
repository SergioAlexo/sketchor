# Pallet Size Generator

Open **Pallet Size Generator** beside **Truck Load Planner** in Sketchor's toolbar. The command is also available in the plugin command palette.

1. Set the maximum footprint and layers in **Pallet rules**. Product padding starts at 1 in per side, and the pallet edge inset starts at 0.5 in. The padded outlines stay inside the inset, leaving 2 in between products and 1.5 in from a product to the deck edge at those settings. **Reset margins** restores the two defaults. **Custom size increment** rounds each custom dimension up. At a 1 in increment, 32.4 in rounds to 33 in.
2. In **Jobs**, enter each job number once, then add its products, quantities, dimensions and weights. New products allow quarter-turns by default. For a product approved for stacking, choose up to four layers and the permitted pattern, then set the pallet's **Max layers** as needed. Alternating stacks put units on layers 2 and 4 upside down. The optional **Max stack height** measures the products above the deck. Supply item heights and measured added height for nested alternating stacks when using this limit.
3. Select **Generate pallets** to draw the layout in the active Sketchor document. A new generation replaces the previous pallet layout there in one undo step. The planner tries rectangular layouts with the allowed turns, ranks them by units placed, pallet count and deck area, and lists any unplaced products.
4. Open **Build a stack** and choose a **Destination pallet**. For example, choose **Pallet 1** and select **A #1**, **A #2** upside down, **B #1**, and **B #2** upside down, in order from bottom to top. Click **Place stack**. The planner reuses the bottom unit's position when it fits on the destination pallet or finds another free position. Next, open **Stack in 2 layers**, choose **Pallet 2** as its **Destination pallet**, select **C #1** through **C #4**, and click **Place in 2 layers**. That places **C #1 / C #2** and **C #3 / C #4** side by side using C's stack pattern. **Pallet preview** follows a successful placement. Use **Move or turn a product** to adjust an individual unit or drag a stack in the preview to move all its layers together.
5. After manual placement, click **Fit custom pallets to layout** below the preview to trim all occupied custom bases to the arranged footprints and configured clearances, rounded up using the custom size increment. Each pallet's stacks shift together as needed to clear unused space at the origin. Stock and manually sized bases keep their specified dimensions.
6. Confirm the plan once all products are placed. Choose **Report folder** once and use **Save report** to write an HTML file there. The name uses the job numbers and Winnipeg date and time, for example **23771_23772_2026-11-26_14-05-32-047.html**. Without a chosen folder, **Save report** uses the browser's normal save flow. **Open report** restores a plan from its HTML report or a previously saved JSON file.

For a walkthrough, select **Load 7-bench example**. The example uses 30 × 15 in products and a 52 × 33 in pallet limit. Six units share the 52 × 33 in base, and the seventh uses a 33 × 18 in base. Set **Max layers** to three and generate again to put the seventh on the third layer of the first pallet. Length and width are sized independently within their limits.

The preview and report use the plan's rectangular footprints and configured layer pattern. Confirm the product's stacking arrangement before loading.

## JSON format and truck handoff

Schema version 2 stores dimensions and coordinates in millimetres. Product placement uses the lower-left corner of its turned footprint. Rotation is 0° or 90°. Version 1 files reopen with their existing placements on layer 1.

| Record | Fields |
| --- | --- |
| Plan | `schemaVersion`, `id`, `revisionId`, `parentRevisionId`, `review`, `products`, `rules`, `pallets`, `unplaced`, and optional `generation` |
| Product row | `id`, `jobId`, `productId`, `quantity`, `lengthMm`, `widthMm`, `canRotate`. Optional height, weight, notes, stacking rules, source row ID and source unit. |
| Pallet | `id`, `jobId`, `base`, `loadedFootprint`, `baseSource`, `placements`, `truckOrientation`. Optional base name, handling tag, packed height and gross weight. |
| Placement | Product unit `id`, `rowId`, `xMm`, `yMm`, `rotation`, `layer`, optional manual `supportId` and `upsideDown` |
| Unplaced product | Product unit `id`, `rowId` and `reason` |

The loaded footprint equals the base. The plan parser checks quantity, IDs, job membership, rotation, layer support, clearances and configured height. Older saved layouts keep their clearance and height calculations when reopened. Generating again uses the visible inset, padding and stack-height settings.

Each HTML report contains the diagrams, per-unit loading tables, the complete plan JSON in `sketchor-pallet-plan`, and the copyable CSV under **Analysis data (CSV)**. The CSV includes plan and revision IDs, rules, product dimensions, pallets, layers, orientations, coordinates and supporting units. Use `changed_since_generation` to find assignments affected by a manual edit. Join revisions by `plan_id`, `revision_id` and `unit_id`. Version 1 files have blank generated fields when their original solve is unavailable.

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
