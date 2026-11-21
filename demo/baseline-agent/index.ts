// Account-free stand-in for the built-in driver, using the same protocol fixture as the test suite.
import { run } from "../../test/fake-agent/fake-agent";
import { endTurn, on, startTurn } from "../../test/fake-agent/scripts";

await run({ script: { on, steps: [...startTurn, ...endTurn("基线回复：已收到请求，没有修改文件。"), { goto: 0 }] } });
