import type {} from "micromark-extension-math";
import type { Construct, State, Token } from "micromark-util-types";
import type {} from "remark-parse";
import type { Plugin } from "unified";

const slash = 92;
const openParen = 40;
const closeParen = 41;

/** Emit the same inline math tokens as remark-math, before Markdown consumes the escapes. */
const parenMath: Construct = {
  tokenize(effects, ok, nok) {
    let escape: Token;

    const start: State = (code) => {
      effects.enter("mathText");
      effects.enter("mathTextSequence");
      effects.consume(code);
      return open;
    };
    const open: State = (code) => {
      if (code !== openParen) return nok(code);
      effects.consume(code);
      effects.exit("mathTextSequence");
      return content;
    };
    const content: State = (code) => {
      if (code === null || code < -2) return nok(code); // EOF or a Markdown line ending
      if (code === slash) {
        escape = effects.enter("mathTextData");
        effects.consume(code);
        return escaped;
      }
      effects.enter("mathTextData");
      return data(code);
    };
    const data: State = (code) => {
      if (code === slash || code === null || code < -2) {
        effects.exit("mathTextData");
        return content(code);
      }
      effects.consume(code);
      return data;
    };
    const escaped: State = (code) => {
      if (code === openParen || code === null || code < -2) return nok(code);
      if (code === closeParen) {
        escape.type = "mathTextSequence";
        effects.consume(code);
        effects.exit("mathTextSequence");
        effects.exit("mathText");
        return ok;
      }
      effects.consume(code); // In particular, a doubled backslash is literal TeX data.
      effects.exit("mathTextData");
      return content;
    };
    return start;
  },
};

/** Only register in Markdown text: code spans, fences and link destinations stay literal. */
export const remarkParenMath: Plugin = function () {
  const data = this.data();
  (data.micromarkExtensions ??= []).push({ text: { [slash]: parenMath } });
};
