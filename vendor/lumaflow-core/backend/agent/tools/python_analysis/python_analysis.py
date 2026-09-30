"""Run analysis with the same interpreter and dependencies as the backend."""
import os
from agent.tools.base_tool import BaseTool, ToolResult
from agent.tools.local_computer.local_computer import execute_local


class PythonAnalysis(BaseTool):
    name = "python_analysis"
    description = "Run Python analysis in the Agent workspace using the installed backend interpreter. pandas, matplotlib, PDF and Office libraries are available. Use for calculations, CSV/Excel analysis and chart generation; send resulting files with send. Actual stdout, stderr and exitCode are returned."
    params = {"type": "object", "properties": {
        "script": {"type": "string"}, "timeoutSeconds": {"type": "integer", "minimum": 1, "maximum": 600},
    }, "required": ["script"]}

    def execute(self, args):
        try:
            receipt = execute_local({"action": "python", "script": args.get("script"),
                                     "timeoutSeconds": args.get("timeoutSeconds", 120)}, self.cwd or os.getcwd())
            if receipt["exitCode"] != 0 or receipt["timedOut"]:
                return ToolResult.fail(receipt)
            return ToolResult.success(receipt)
        except (ValueError, OSError, TypeError) as exc:
            return ToolResult.fail(str(exc))
