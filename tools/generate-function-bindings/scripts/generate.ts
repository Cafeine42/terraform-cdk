// uses the functions.json file to generate the bindings for CDKTF

import fs from "fs/promises";
import * as path from "path";
import { AttributeType } from "@cdktf/provider-generator";
import generate from "@babel/generator";
import template from "@babel/template";
import * as t from "@babel/types";
import prettier from "prettier";
import { FUNCTIONS_METADATA_FILE } from "./fetch-metadata";

const ts = template({ plugins: [["typescript", {}]] });

const OUTPUT_FILE = path.resolve(
  __dirname,
  "..",
  "..",
  "..",
  "packages",
  "cdktf",
  "lib",
  "functions",
  "terraform-functions.generated.ts"
);

type Parameter = { name: string; type: AttributeType };
type FunctionSignature = {
  description: string;
  return_type: AttributeType;
  parameters: Parameter[];
  variadic_parameter: Parameter;
};
type MappedParameter = {
  name: string;
  mapper: string;
  tsParam: t.Identifier;
  docstringType: string;
};

const IMPORTS = ts`
import {
  anyValue,
  asAny,
  asBoolean,
  asList,
  asNumber,
  asString,
  listOf,
  mapValue,
  numericValue,
  stringValue,
  terraformFunction,
  variadic,
} from "./helpers";
`() as t.Statement;
t.addComment(
  IMPORTS,
  "leading",
  `\n * This file is generated by tools/generate-funtion-bindings.
 * To update this file execute 'yarn run generate-function-bindings' in the root of the repository
 `,
  false
);

// these are overwritten in terraform-functions.ts
const INTERNAL_METHODS = ["join", "bcrypt", "range", "lookup"];

async function fetchMetadata() {
  const file = path.join(__dirname, FUNCTIONS_METADATA_FILE);
  const json = JSON.parse((await fs.readFile(file)).toString())
    .function_signatures as {
    [name: string]: FunctionSignature;
  };

  const staticMethods = Object.entries(json)
    .sort(fakeSameSortOrderAsExistingFile)
    .map(([name, signature]) => renderStaticMethod(name, signature));

  const fnClass = t.exportNamedDeclaration(
    t.classDeclaration(
      t.identifier("FnGenerated"),
      null,
      t.classBody(staticMethods)
    )
  );
  t.addComment(
    fnClass,
    "leading",
    " eslint-disable-next-line jsdoc/require-jsdoc",
    true
  );

  const program = t.program([IMPORTS, fnClass]);

  const code = prettier.format(generate(program as any).code, {
    parser: "babel",
  });

  await fs.writeFile(OUTPUT_FILE, code);
}

// TODO: special case handlings:
// lookup() -> third param is optional, but due to current handling now an array of any instead of just "any?"

function renderStaticMethod(
  name: string,
  signature: FunctionSignature
): t.ClassMethod {
  let returnType = "";
  switch (signature.return_type) {
    case "number":
      returnType = "asNumber";
      break;
    case "string":
      returnType = "asString";
      break;
    case "bool":
      returnType = "asBoolean";
      break;
    case "dynamic":
      returnType = "asAny"; // TODO: this was no wrapping but now is asAny (BREAKING, as it used to return IResolvable for some functions but now returns any)
      break;
    default:
      if (
        Array.isArray(signature.return_type) &&
        (signature.return_type[0] === "list" ||
          signature.return_type[0] === "set")
      ) {
        returnType = "asList";
      } else if (
        Array.isArray(signature.return_type) &&
        signature.return_type[0] === "map"
      ) {
        returnType = "asAny";
      } else {
        throw new Error(
          `Function ${name} has unsupported return type: ${JSON.stringify(
            signature.return_type
          )}`
        );
      }
  }

  const mapParameter = (p: Parameter) => {
    let name = p.name;
    if (name === "default") name = "defaultValue"; // keyword in TypeScript
    if (name === "string") name = "str"; // causes issue is Go

    const parseType = (
      type: AttributeType
    ): { mapper: string; tsType: t.TSType; docstringType: string } => {
      if (type === "number") {
        return {
          mapper: "numericValue",
          tsType: t.tsNumberKeyword(),
          docstringType: "number",
        };
      } else if (type === "string") {
        return {
          mapper: "stringValue",
          tsType: t.tsStringKeyword(),
          docstringType: "string",
        };
      } else if (type === "bool") {
        return {
          mapper: "anyValue",
          tsType: t.tsAnyKeyword(), // we can't use booleans here as we don't have boolean tokens but need to support token values too
          docstringType: "any",
        };
      } else if (type === "dynamic") {
        return {
          mapper: "anyValue",
          tsType: t.tsAnyKeyword(),
          docstringType: "any",
        };
      } else if (
        Array.isArray(type) &&
        (type[0] === "list" || type[0] === "set")
      ) {
        const child = parseType(type[1]);

        // We use anyValue for string lists as we don't validate
        // the individual strings in a list to make using these
        // functions more graceful
        if (type[1] === "string") {
          child.mapper = "anyValue";
        }

        return {
          mapper: `listOf(${child.mapper})`,
          tsType: t.tsArrayType(child.tsType),
          docstringType: `Array<${child.docstringType}>`,
        };
      } else if (Array.isArray(type) && type[0] === "map") {
        const child = parseType(type[1]);
        return {
          mapper: "mapValue",
          tsType: t.tsAnyKeyword(),
          docstringType: "Object<string, " + child.docstringType + ">",
        };
      } else {
        throw new Error(
          `Function ${name} has parameter ${
            p.name
          } with unsupported type ${JSON.stringify(p.type)}`
        );
      }
    };

    const { docstringType, mapper, tsType } = parseType(p.type);

    const tsParam = t.identifier(name);
    tsParam.typeAnnotation = t.tsTypeAnnotation(tsType);

    return { name, mapper, tsParam, docstringType };
  };

  const parameters: MappedParameter[] = (signature.parameters || []).map(
    mapParameter
  );

  if (signature.variadic_parameter) {
    const p = mapParameter(signature.variadic_parameter);
    p.tsParam.typeAnnotation = t.tsTypeAnnotation(
      t.tsArrayType(
        (p.tsParam.typeAnnotation as t.TSTypeAnnotation).typeAnnotation
      )
    );
    parameters.push({
      name: p.name,
      docstringType: `Array<${p.docstringType}>`,
      mapper: `variadic(${p.mapper})`,
      tsParam: p.tsParam,
    });
  }

  // we need a space (Prettier will remove it) as somehow ts`` works in weird ways when
  // passing an empty (or falsy value in the template string)
  const argValueMappers: string =
    parameters.map((p) => p.mapper).join(",") || " ";
  const argNames: string = parameters.map((p) => p.name).join(",");
  const params: any[] = parameters.map((p) => p.tsParam);

  const body = ts`
  return ${returnType}(terraformFunction("${name}", [${argValueMappers}])(${argNames}));
  `();

  const isInternal = INTERNAL_METHODS.includes(name);

  let sanitizedFunctionName = name === "length" ? "lengthOf" : name;
  if (isInternal) {
    sanitizedFunctionName = `_${sanitizedFunctionName}`;
  }

  const method = t.classMethod(
    "method",
    t.stringLiteral(sanitizedFunctionName),
    params,
    t.blockStatement(Array.isArray(body) ? body : [body]),
    false, // computed
    true // static
  );

  // comment with docstring for method
  const descriptionWithLink = signature.description.replace(
    `\`${name}\``,
    `{@link https://www.terraform.io/docs/language/functions/${name}.html ${name}}`
  );
  t.addComment(
    method,
    "leading",
    [
      "*",
      ...(isInternal ? ["* @internal"] : []),
      `* ${descriptionWithLink}`,
      ...parameters.map((p) => ` * @param {${p.docstringType}} ${p.name}`),
      "",
    ].join("\n")
  );

  return method;
}

fetchMetadata();

const old = [
  "alltrue",
  "anytrue",
  "chunklist",
  "coalesce",
  "coalescelist",
  "compact",
  "concat",
  "contains",
  "distinct",
  "element",
  "flatten",
  "index",
  "keys",
  "length",
  "lookup",
  "matchkeys",
  "mergeLists",
  "mergeMaps",
  "one",
  "range",
  "reverse",
  "setintersection",
  "setproduct",
  "setsubtract",
  "setunion",
  "slice",
  "sort",
  "sum",
  "transpose",
  "values",
  "zipmap",
  "base64sha256",
  "base64sha512",
  "bcrypt",
  "filebase64sha256",
  "filebase64sha512",
  "filemd5",
  "filesha1",
  "filesha256",
  "filesha512",
  "md5",
  "rsadecrypt",
  "sha1",
  "sha256",
  "sha512",
  "uuid",
  "uuidv5",
  "formatdate",
  "timeadd",
  "timestamp",
  "base64decode",
  "base64encode",
  "base64gzip",
  "csvdecode",
  "jsondecode",
  "jsonencode",
  "textdecodebase64",
  "textencodebase64",
  "urlencode",
  "yamldecode",
  "yamlencode",
  "abspath",
  "dirname",
  "pathexpand",
  "basename",
  "file",
  "fileexists",
  "fileset",
  "filebase64",
  "templatefile",
  "cidrhost",
  "cidrnetmask",
  "cidrsubnet",
  "cidrsubnets",
  "abs",
  "ceil",
  "floor",
  "log",
  "max",
  "min",
  "parseInt",
  "pow",
  "signum",
  "chomp",
  "format",
  "formatlist",
  "indent",
  "join",
  "lower",
  "regexall",
  "regex",
  "replace",
  "split",
  "strrev",
  "substr",
  "title",
  "trim",
  "trimprefix",
  "trimsuffix",
  "trimspace",
  "upper",
  "can",
  "nonsensitive",
  "sensitive",
  "tobool",
  "tolist",
  "tomap",
  "tonumber",
  "toset",
  "tostring",
  "try",
];
// fakes the sort order, our existing terraform-functions.ts file has
// this makes it easier to compare the generated file to the existing function bindings
function fakeSameSortOrderAsExistingFile(
  [a]: [string, ...any[]],
  [b]: [string, ...any[]]
): number {
  return old.indexOf(a) - old.indexOf(b);
}
