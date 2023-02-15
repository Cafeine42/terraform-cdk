import generate from "@babel/generator";
import { terraformExpressionToAst } from "../lib/expressions";
import { Scope } from "../lib/types";

const mockScope: Scope = {
  constructs: new Set(),
  providerGenerator: {},
  providerSchema: {},
  variables: {},
};

const mockPath = "";

describe("terraformExpressionToAst", () => {
  it.skip("should use Fn.element for function call", async () => {
    expect(
      generate(
        await terraformExpressionToAst(
          mockScope,
          "${element(var.list, 0)}",
          mockPath,
          ["var.list"]
        )
      ).code
    ).toEqual("cdktf.Fn.element(var.list, 0)");
  });
  it("should use Op.add for operator usage", async () => {
    expect(
      generate(
        await terraformExpressionToAst(mockScope, `\${1 + 2}`, mockPath, [])
      ).code
    ).toEqual(`cdktf.Op.add("1", "2")`);
  });
  it("should return literal value as is", async () => {
    expect(
      generate(
        await terraformExpressionToAst(mockScope, `\${"abc"}`, mockPath, [])
      ).code
    ).toEqual(`"\${\\"abc\\"}"`);
  });
  it.skip("should resolve references", async () => {
    // TODO: figure out how to invoke this so we'll actually see something here
    expect(
      generate(
        await terraformExpressionToAst(mockScope, `\${var.list}`, mockPath, [])
      ).code
    ).toEqual(`\${"abc"}`);
  });
  it.todo("should resolve nested functions and operations using references");
});
