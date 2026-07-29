import{i as e,n as t,r as n,t as r}from"./jsx-runtime-Dr0RuP1R.js";var i=e(n(),1),a=e(t(),1),o="---\nname: validate-meeting-items\ndescription: Validate structured meeting decision and action-item candidates against source transcript segments. Use when checking whether meeting items have valid provenance, explicit owners and deadlines, formal decision language, non-invented fields, and correct human-confirmation flags before review, export, or task creation.\n---\n\n# Validate Meeting Items\n\nApply a deterministic compliance gate after semantic extraction and before human review or export. Never infer missing values.\n\n## Workflow\n\n1. Prepare one JSON input that follows [references/schema.md](references/schema.md).\n2. Run:\n\n   ```bash\n   python3 scripts/validate_items.py --input INPUT.json --output OUTPUT.json\n   ```\n\n3. Inspect each result:\n\n   - `valid`: allow into the review-ready list.\n   - `needs_confirmation`: require a person to correct or confirm it.\n   - `rejected`: keep the audit result but do not treat it as a decision or task.\n\n4. Preserve `source_segment_ids`, `evidence`, `violations`, and `original_item` in downstream records.\n5. Do not create tasks automatically from any result. Human confirmation remains the final gate.\n\n## Rules\n\n- Require `content_type` to be `decision` or `action`.\n- Require a non-empty description and at least one existing source segment.\n- Reject a claimed decision when its evidence is only a suggestion, question, dispute, or explicit non-decision.\n- For actions, require an explicit owner and deadline; otherwise mark `needs_confirmation`.\n- Treat vague deadlines such as `尽快`, `回头`, and `后面` as requiring confirmation.\n- Reject an owner or deadline that does not appear verbatim in the bound evidence.\n- Mark third-person assignment language such as `让张伟` as requiring confirmation even when the owner appears in evidence.\n- Never rewrite, infer, or supplement the candidate fields.\n\n## Output Contract\n\nReturn the input `meeting_id`, one result per item, and a summary count. Each result must contain:\n\n- `status`\n- `content_type`\n- `description`\n- `owner`\n- `deadline`\n- `source_segment_ids`\n- `needs_human_confirmation`\n- `evidence`\n- `violations`\n- `original_item`\n\nRead [references/schema.md](references/schema.md) when constructing integrations or new fixtures.\n",s=`#!/usr/bin/env python3
"""Deterministic compliance validation for meeting-item candidates."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any


DISCUSSION_MARKERS = (
    "建议",
    "可以考虑",
    "要不要",
    "是否可以",
    "可能",
    "再讨论",
    "先讨论",
    "未决定",
    "不决定",
    "待定",
    "看看",
)
DECISION_MARKERS = ("决定", "确定", "确认", "结论", "就这么定", "同意", "采用")
NON_DECISION_MARKERS = ("未决定", "不决定", "还没定", "尚未确定", "待定")
ACTION_MARKERS = ("负责", "提交", "完成", "整理", "上线", "交付", "跟进", "我来", "由")
VAGUE_DEADLINES = ("尽快", "回头", "后面", "有空", "近期", "晚点", "抽空")


def violation(code: str, field: str, severity: str, message: str) -> dict[str, str]:
    return {
        "code": code,
        "field": field,
        "severity": severity,
        "message": message,
    }


def validate_item(item: dict[str, Any], segments: dict[str, str]) -> dict[str, Any]:
    violations: list[dict[str, str]] = []
    content_type = item.get("content_type")
    description = item.get("description")
    owner = item.get("owner")
    deadline = item.get("deadline")
    source_ids = item.get("source_segment_ids")

    if content_type not in {"decision", "action"}:
        violations.append(
            violation("INVALID_CONTENT_TYPE", "content_type", "reject", "内容类型只能是 decision 或 action。")
        )
    if not isinstance(description, str) or not description.strip():
        violations.append(violation("EMPTY_DESCRIPTION", "description", "reject", "描述不能为空。"))

    if not isinstance(source_ids, list) or not source_ids:
        source_ids = []
        violations.append(
            violation("MISSING_SOURCE", "source_segment_ids", "reject", "必须绑定至少一个原始字幕片段。")
        )

    missing_source_ids = [source_id for source_id in source_ids if source_id not in segments]
    if missing_source_ids:
        violations.append(
            violation(
                "SOURCE_NOT_FOUND",
                "source_segment_ids",
                "reject",
                f"找不到字幕片段：{', '.join(missing_source_ids)}。",
            )
        )

    evidence = "\\n".join(segments[source_id] for source_id in source_ids if source_id in segments)
    has_discussion_marker = any(marker in evidence for marker in DISCUSSION_MARKERS)
    has_decision_marker = any(marker in evidence for marker in DECISION_MARKERS)
    has_non_decision_marker = any(marker in evidence for marker in NON_DECISION_MARKERS)
    has_action_marker = any(marker in evidence for marker in ACTION_MARKERS)

    if content_type == "decision" and (
        has_non_decision_marker or (has_discussion_marker and not has_decision_marker)
    ):
        violations.append(
            violation(
                "DISCUSSION_NOT_DECISION",
                "content_type",
                "reject",
                "证据仅包含建议、讨论或未定论表达，不能判定为正式决策。",
            )
        )
    elif content_type == "decision" and evidence and not has_decision_marker:
        violations.append(
            violation(
                "DECISION_EVIDENCE_AMBIGUOUS",
                "content_type",
                "confirm",
                "未检测到明确决策措辞，需要人工复核。",
            )
        )

    if content_type == "action":
        if not owner:
            violations.append(
                violation("MISSING_OWNER", "owner", "confirm", "行动项缺少明确责任人。")
            )
        if not deadline:
            violations.append(
                violation("MISSING_DEADLINE", "deadline", "confirm", "行动项缺少明确截止时间。")
            )
        if evidence and not has_action_marker:
            violations.append(
                violation(
                    "ACTION_EVIDENCE_AMBIGUOUS",
                    "description",
                    "confirm",
                    "未检测到明确执行或承诺措辞，需要人工复核。",
                )
            )

    if owner and evidence and str(owner) not in evidence:
        violations.append(
            violation(
                "OWNER_NOT_IN_SOURCE",
                "owner",
                "reject",
                "责任人未出现在绑定字幕中，疑似虚构或错配。",
            )
        )
    if deadline and evidence and str(deadline) not in evidence:
        violations.append(
            violation(
                "DEADLINE_NOT_IN_SOURCE",
                "deadline",
                "reject",
                "截止时间未出现在绑定字幕中，疑似虚构或错配。",
            )
        )
    if deadline and any(marker in str(deadline) for marker in VAGUE_DEADLINES):
        violations.append(
            violation(
                "VAGUE_DEADLINE",
                "deadline",
                "confirm",
                "截止时间属于模糊表述，需要人工补充明确日期。",
            )
        )
    if owner and evidence and any(
        pattern in evidence for pattern in (f"让{owner}", f"叫{owner}", f"安排{owner}")
    ):
        violations.append(
            violation(
                "THIRD_PARTY_ASSIGNMENT",
                "owner",
                "confirm",
                "证据是第三方指派，不得自动视为责任人本人承诺。",
            )
        )

    severities = {item["severity"] for item in violations}
    if "reject" in severities:
        status = "rejected"
    elif "confirm" in severities:
        status = "needs_confirmation"
    else:
        status = "valid"

    return {
        "status": status,
        "content_type": content_type,
        "description": description,
        "owner": owner,
        "deadline": deadline,
        "source_segment_ids": source_ids,
        "needs_human_confirmation": status != "valid",
        "evidence": evidence,
        "violations": violations,
        "original_item": item,
    }


def validate_payload(payload: dict[str, Any]) -> dict[str, Any]:
    transcript_segments = payload.get("transcript_segments")
    items = payload.get("items")
    if not isinstance(transcript_segments, list):
        raise ValueError("transcript_segments must be an array")
    if not isinstance(items, list):
        raise ValueError("items must be an array")

    segments = {
        str(segment["id"]): str(segment["text"])
        for segment in transcript_segments
        if isinstance(segment, dict) and segment.get("id") is not None and segment.get("text") is not None
    }
    results = [
        validate_item(item if isinstance(item, dict) else {}, segments)
        for item in items
    ]
    summary = {
        "total": len(results),
        "valid": sum(result["status"] == "valid" for result in results),
        "needs_confirmation": sum(result["status"] == "needs_confirmation" for result in results),
        "rejected": sum(result["status"] == "rejected" for result in results),
    }
    return {
        "meeting_id": payload.get("meeting_id"),
        "results": results,
        "summary": summary,
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", required=True, type=Path)
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()

    payload = json.loads(args.input.read_text(encoding="utf-8"))
    output = validate_payload(payload)
    rendered = json.dumps(output, ensure_ascii=False, indent=2)
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(rendered + "\\n", encoding="utf-8")
    else:
        print(rendered)


if __name__ == "__main__":
    main()
`,c=`#!/usr/bin/env python3
"""Run three prototype acceptance cases and save reviewed results."""

from __future__ import annotations

import json
from pathlib import Path

from validate_items import validate_payload


CASES = [
    {
        "name": "normal-explicit-action",
        "payload": {
            "meeting_id": "test-001",
            "transcript_segments": [
                {"id": "seg-001", "text": "张伟：我来负责接口文档，周五下班前提交。"}
            ],
            "items": [
                {
                    "content_type": "action",
                    "description": "提交接口文档",
                    "owner": "张伟",
                    "deadline": "周五下班前",
                    "source_segment_ids": ["seg-001"],
                }
            ],
        },
        "expected_status": "valid",
        "expected_codes": [],
    },
    {
        "name": "boundary-missing-owner-and-deadline",
        "payload": {
            "meeting_id": "test-002",
            "transcript_segments": [
                {"id": "seg-002", "text": "把客户反馈整理一下，尽快处理。"}
            ],
            "items": [
                {
                    "content_type": "action",
                    "description": "整理客户反馈",
                    "owner": None,
                    "deadline": None,
                    "source_segment_ids": ["seg-002"],
                }
            ],
        },
        "expected_status": "needs_confirmation",
        "expected_codes": ["MISSING_OWNER", "MISSING_DEADLINE"],
    },
    {
        "name": "failure-discussion-misclassified-as-decision",
        "payload": {
            "meeting_id": "test-003",
            "transcript_segments": [
                {"id": "seg-003", "text": "这个方案可以考虑，下周再讨论，今天先不决定。"}
            ],
            "items": [
                {
                    "content_type": "decision",
                    "description": "采用该方案",
                    "owner": None,
                    "deadline": None,
                    "source_segment_ids": ["seg-003"],
                }
            ],
        },
        "expected_status": "rejected",
        "expected_codes": ["DISCUSSION_NOT_DECISION"],
    },
]


def main() -> None:
    reviewed = []
    for case in CASES:
        output = validate_payload(case["payload"])
        result = output["results"][0]
        actual_codes = [item["code"] for item in result["violations"]]
        passed = (
            result["status"] == case["expected_status"]
            and all(code in actual_codes for code in case["expected_codes"])
        )
        reviewed.append(
            {
                "name": case["name"],
                "passed": passed,
                "expected_status": case["expected_status"],
                "actual_status": result["status"],
                "expected_codes": case["expected_codes"],
                "actual_codes": actual_codes,
                "output": output,
            }
        )

    results = {
        "total": len(reviewed),
        "passed": sum(item["passed"] for item in reviewed),
        "failed": sum(not item["passed"] for item in reviewed),
        "cases": reviewed,
    }
    output_path = Path(__file__).resolve().parents[1] / "test-results.json"
    output_path.write_text(json.dumps(results, ensure_ascii=False, indent=2) + "\\n", encoding="utf-8")
    print(json.dumps(results, ensure_ascii=False, indent=2))
    if results["failed"]:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
`,l=`# Input and output schema

## Input

\`\`\`json
{
  "meeting_id": "meeting-001",
  "transcript_segments": [
    {
      "id": "seg-001",
      "text": "张伟：我来负责接口文档，周五下班前提交。"
    }
  ],
  "items": [
    {
      "content_type": "action",
      "description": "提交接口文档",
      "owner": "张伟",
      "deadline": "周五下班前",
      "source_segment_ids": ["seg-001"]
    }
  ]
}
\`\`\`

Required top-level fields: \`transcript_segments\`, \`items\`.

Required item fields: \`content_type\`, \`description\`, \`owner\`, \`deadline\`, \`source_segment_ids\`. Use \`null\` for missing owner or deadline. Do not omit fields.

## Output

\`\`\`json
{
  "meeting_id": "meeting-001",
  "results": [
    {
      "status": "valid",
      "content_type": "action",
      "description": "提交接口文档",
      "owner": "张伟",
      "deadline": "周五下班前",
      "source_segment_ids": ["seg-001"],
      "needs_human_confirmation": false,
      "evidence": "张伟：我来负责接口文档，周五下班前提交。",
      "violations": [],
      "original_item": {}
    }
  ],
  "summary": {
    "total": 1,
    "valid": 1,
    "needs_confirmation": 0,
    "rejected": 0
  }
}
\`\`\`

Violation objects contain \`code\`, \`field\`, \`severity\`, and \`message\`.

Status precedence: \`rejected\` over \`needs_confirmation\` over \`valid\`.
`,u=`{
  "total": 3,
  "passed": 3,
  "failed": 0,
  "cases": [
    {
      "name": "normal-explicit-action",
      "passed": true,
      "expected_status": "valid",
      "actual_status": "valid",
      "expected_codes": [],
      "actual_codes": [],
      "output": {
        "meeting_id": "test-001",
        "results": [
          {
            "status": "valid",
            "content_type": "action",
            "description": "提交接口文档",
            "owner": "张伟",
            "deadline": "周五下班前",
            "source_segment_ids": [
              "seg-001"
            ],
            "needs_human_confirmation": false,
            "evidence": "张伟：我来负责接口文档，周五下班前提交。",
            "violations": [],
            "original_item": {
              "content_type": "action",
              "description": "提交接口文档",
              "owner": "张伟",
              "deadline": "周五下班前",
              "source_segment_ids": [
                "seg-001"
              ]
            }
          }
        ],
        "summary": {
          "total": 1,
          "valid": 1,
          "needs_confirmation": 0,
          "rejected": 0
        }
      }
    },
    {
      "name": "boundary-missing-owner-and-deadline",
      "passed": true,
      "expected_status": "needs_confirmation",
      "actual_status": "needs_confirmation",
      "expected_codes": [
        "MISSING_OWNER",
        "MISSING_DEADLINE"
      ],
      "actual_codes": [
        "MISSING_OWNER",
        "MISSING_DEADLINE"
      ],
      "output": {
        "meeting_id": "test-002",
        "results": [
          {
            "status": "needs_confirmation",
            "content_type": "action",
            "description": "整理客户反馈",
            "owner": null,
            "deadline": null,
            "source_segment_ids": [
              "seg-002"
            ],
            "needs_human_confirmation": true,
            "evidence": "把客户反馈整理一下，尽快处理。",
            "violations": [
              {
                "code": "MISSING_OWNER",
                "field": "owner",
                "severity": "confirm",
                "message": "行动项缺少明确责任人。"
              },
              {
                "code": "MISSING_DEADLINE",
                "field": "deadline",
                "severity": "confirm",
                "message": "行动项缺少明确截止时间。"
              }
            ],
            "original_item": {
              "content_type": "action",
              "description": "整理客户反馈",
              "owner": null,
              "deadline": null,
              "source_segment_ids": [
                "seg-002"
              ]
            }
          }
        ],
        "summary": {
          "total": 1,
          "valid": 0,
          "needs_confirmation": 1,
          "rejected": 0
        }
      }
    },
    {
      "name": "failure-discussion-misclassified-as-decision",
      "passed": true,
      "expected_status": "rejected",
      "actual_status": "rejected",
      "expected_codes": [
        "DISCUSSION_NOT_DECISION"
      ],
      "actual_codes": [
        "DISCUSSION_NOT_DECISION"
      ],
      "output": {
        "meeting_id": "test-003",
        "results": [
          {
            "status": "rejected",
            "content_type": "decision",
            "description": "采用该方案",
            "owner": null,
            "deadline": null,
            "source_segment_ids": [
              "seg-003"
            ],
            "needs_human_confirmation": true,
            "evidence": "这个方案可以考虑，下周再讨论，今天先不决定。",
            "violations": [
              {
                "code": "DISCUSSION_NOT_DECISION",
                "field": "content_type",
                "severity": "reject",
                "message": "证据仅包含建议、讨论或未定论表达，不能判定为正式决策。"
              }
            ],
            "original_item": {
              "content_type": "decision",
              "description": "采用该方案",
              "owner": null,
              "deadline": null,
              "source_segment_ids": [
                "seg-003"
              ]
            }
          }
        ],
        "summary": {
          "total": 1,
          "valid": 0,
          "needs_confirmation": 0,
          "rejected": 1
        }
      }
    }
  ]
}
`,d=`interface:
  display_name: "会议事项合规校验"
  short_description: "校验会议决策和行动项，标记缺失、越界与人工确认事项"
  default_prompt: "使用 $validate-meeting-items 校验会议事项候选结果，并输出合规状态、问题与人工确认标记。"
`,f=r(),p=[{path:`SKILL.md`,group:`ROOT`,language:`Markdown`,source:o},{path:`scripts/validate_items.py`,group:`SCRIPTS`,language:`Python`,source:s},{path:`scripts/run_tests.py`,group:`SCRIPTS`,language:`Python`,source:c},{path:`references/schema.md`,group:`REFERENCES`,language:`Markdown`,source:l},{path:`test-results.json`,group:`ROOT`,language:`JSON`,source:u},{path:`agents/openai.yaml`,group:`AGENTS`,language:`YAML`,source:d}];function m(){let[e,t]=(0,i.useState)(`SKILL.md`),[n,r]=(0,i.useState)(!1),a=p.find(t=>t.path===e),o=a.source.trimEnd().split(`
`),s=p.reduce((e,t)=>e+t.source.trimEnd().split(`
`).length,0);return(0,f.jsxs)(`main`,{className:`source-app`,children:[(0,f.jsxs)(`header`,{children:[(0,f.jsxs)(`a`,{className:`wordmark`,href:`../../`,children:[(0,f.jsx)(`i`,{}),`MEETING INTELLIGENCE`]}),(0,f.jsxs)(`div`,{className:`header-meta`,children:[(0,f.jsx)(`span`,{children:`SOURCE ARTIFACT · SKILL.md`}),(0,f.jsx)(`b`,{children:`Design by Zach｜扎克的自留地`})]})]}),(0,f.jsxs)(`section`,{className:`source-hero`,children:[(0,f.jsxs)(`div`,{children:[(0,f.jsx)(`p`,{children:`SKILL 原始交付物 / 完整目录`}),(0,f.jsxs)(`h1`,{children:[`不只主文件，`,(0,f.jsx)(`em`,{children:`是整个 Skill。`})]})]}),(0,f.jsxs)(`div`,{className:`hero-actions`,children:[(0,f.jsx)(`a`,{href:`../`,children:`← 返回运行演示`}),(0,f.jsx)(`button`,{onClick:async()=>{await navigator.clipboard.writeText(a.source),r(!0),window.setTimeout(()=>r(!1),1600)},children:n?`已复制`:`复制当前文件`})]})]}),(0,f.jsxs)(`section`,{className:`source-layout`,children:[(0,f.jsxs)(`aside`,{children:[(0,f.jsx)(`span`,{className:`file-type`,children:`SKILL`}),(0,f.jsx)(`h2`,{children:`validate-meeting-items`}),(0,f.jsx)(`p`,{children:`完整文件树逐个呈现。点击文件名查看原文，全部内容均直接读取自 Skill 目录。`}),(0,f.jsxs)(`dl`,{children:[(0,f.jsxs)(`div`,{children:[(0,f.jsx)(`dt`,{children:`文件`}),(0,f.jsx)(`dd`,{children:p.length})]}),(0,f.jsxs)(`div`,{children:[(0,f.jsx)(`dt`,{children:`总代码行`}),(0,f.jsx)(`dd`,{children:s})]}),(0,f.jsxs)(`div`,{children:[(0,f.jsx)(`dt`,{children:`测试`}),(0,f.jsx)(`dd`,{children:`3 / 3 PASSED`})]}),(0,f.jsxs)(`div`,{children:[(0,f.jsx)(`dt`,{children:`状态`}),(0,f.jsx)(`dd`,{className:`ready`,children:`SOURCE OF TRUTH`})]})]}),(0,f.jsxs)(`div`,{className:`file-tree`,"aria-label":`Skill 完整文件目录`,children:[(0,f.jsx)(`span`,{children:`完整文件目录`}),[`ROOT`,`SCRIPTS`,`REFERENCES`,`AGENTS`].map(n=>(0,f.jsxs)(`div`,{className:`tree-group`,children:[(0,f.jsx)(`b`,{children:n}),p.filter(e=>e.group===n).map(n=>(0,f.jsxs)(`button`,{className:e===n.path?`active`:``,onClick:()=>t(n.path),children:[(0,f.jsx)(`i`,{children:n.language===`Python`?`PY`:n.language===`JSON`?`{}`:n.language===`YAML`?`YML`:`MD`}),(0,f.jsx)(`span`,{children:n.path.split(`/`).at(-1)}),(0,f.jsx)(`small`,{children:n.source.trimEnd().split(`
`).length})]},n.path))]},n))]})]}),(0,f.jsxs)(`article`,{className:`source-panel`,children:[(0,f.jsxs)(`div`,{className:`source-toolbar`,children:[(0,f.jsxs)(`div`,{children:[(0,f.jsx)(`i`,{}),(0,f.jsx)(`i`,{}),(0,f.jsx)(`i`,{})]}),(0,f.jsxs)(`strong`,{children:[`skill-prototype / `,a.path]}),(0,f.jsxs)(`span`,{children:[a.language.toUpperCase(),` · `,o.length,` LINES`]})]}),(0,f.jsx)(`pre`,{"aria-label":`${a.path} 完整原文`,children:o.map((e,t)=>(0,f.jsxs)(`span`,{className:`source-line`,id:`line-${t+1}`,children:[(0,f.jsx)(`b`,{children:String(t+1).padStart(2,`0`)}),(0,f.jsx)(`code`,{children:e||` `})]},t))})]})]})]})}a.createRoot(document.getElementById(`root`)).render((0,f.jsx)(i.StrictMode,{children:(0,f.jsx)(m,{})}));