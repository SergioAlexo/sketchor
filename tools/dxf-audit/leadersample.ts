// Writes a leader sample (plain LEADER + MTEXT, empty LEADER, MULTILEADER with a branch, balloon) for `python tools/dxf-audit/audit.py`. Local check only.
import { writeFileSync } from "node:fs";
import { entitiesToDxf2018 } from "../../packages/core/src/dxfw/index";
import { addLeaderLine, buildLeader } from "../../packages/core/src/dimensions/leaderOps";
import "../../packages/core/src/kinds/builtin";

const P = (x: number, y: number) => ({ x, y });
const plain = buildLeader([P(0, 0), P(10, 10), P(20, 10)], { text: "SEE NOTE 4" }, { id: "l1" })!;
const empty = buildLeader([P(0, 30), P(12, 40)], {}, { id: "l2" })!;
const multi = addLeaderLine(buildLeader([P(40, 0), P(50, 10)], { text: "TYP" }, { id: "l3" })!, P(40, 20));
const balloon = buildLeader([P(40, 40), P(55, 50)], { text: "7", balloon: "circle" }, { id: "l4" })!;
writeFileSync(process.argv[2] ?? "leadersample.dxf", entitiesToDxf2018([plain, empty, multi, balloon]));
