# Pallet Size Generator

Open **Pallet Size Generator** beside **Truck Load Planner** in Sketchor's toolbar. The command is also available in the plugin command palette.

Each time the panel opens, it starts with a blank job and uses the rules from the last plan. Use **Add job** at the top of **Jobs** to include another job in the same plan. Use **Open report** to continue a saved plan.

1. Set the maximum footprint and layers in **Pallet rules**. Product padding starts at 1 in per side, and the pallet edge inset starts at 0.5 in. The padded outlines stay inside the inset, leaving 2 in between products and 1.5 in from a product to the deck edge at those settings. **Reset margins** restores the two defaults. **Custom size increment** rounds each custom dimension up. At a 1 in increment, 32.4 in rounds to 33 in.
2. In **Jobs**, enter the job number, product name, quantity and dimensions. New jobs start in inches. Each unit appears separately in the 2D drawing when the required fields are complete. **Show products in 2D** also applies the form immediately. Open the row's **⋯** menu for rotation, stack pattern and added height per layer. Set **Max layers** and the optional **Max stack height** in **Pallet rules**.
3. Drag a product onto the centre of another. A highlighted outline marks the supporting product. Dropping **A2** onto **A1** creates the stack **A1 / A2**, with A1 on the bottom. Drag beside other products to arrange them on the same deck. For precise control, select the product, Shift-select the support, then use **Stack on selected support** in the context menu. **Separate top unit** takes the top unit off a stack.
4. Window-select or Shift-select the outlines for a single pallet, then right-click and choose **Form pallet**. Products from the same job can share a pallet. The planner adds the configured gap between touching outlines and fits the base around the group. Move overlapping outlines apart before forming the pallet. To adjust an existing group, select its deck outline and use **Release pallet contents**. **Use current drawing** reconnects the last matching plan after the panel is reopened.
5. After manual placement, click **Fit custom pallets to layout** below the preview to trim all occupied custom bases to the arranged footprints and configured clearances, rounded up using the custom size increment. Each pallet's stacks shift together as needed to clear unused space at the origin. Stock and manually sized bases keep their specified dimensions.
6. Apply any 2D changes, confirm the plan, and click **Save report**. Choose **Report folder** to write the HTML file there. The name uses the job numbers and Winnipeg date and time, for example **23771_23772_2026-11-26_14-05-32-047.html**. Without a chosen folder, **Save report** uses the browser's normal save flow. **Open report** restores a plan from its HTML report or a previously saved JSON file.

If the dimensions in a manual plan were all entered as millimetres but meant as inches, use **Treat entered mm values as inches**. The planner retains the groups and recalculates pallet sizes using the existing rules.

The preview and report use the plan's rectangular footprints and configured layer pattern. Confirm the product's stacking arrangement before loading.

## JSON format and truck handoff

Schema version 2 stores dimensions and coordinates in millimetres. Product placement uses the lower-left corner of its turned footprint. Rotation is 0° or 90°. Version 1 files reopen with their existing placements on layer 1.

| Record | Fields |
| --- | --- |
| Plan | `schemaVersion`, `id`, `revisionId`, `parentRevisionId`, `review`, `products`, `rules`, `pallets`, `unplaced`, and optional `generation` and `looseStacks`. A loose stack stores the drawing origin and its bottom-to-top placements. Its units are tracked as unplaced until they are assigned to a pallet. |
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
