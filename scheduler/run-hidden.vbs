' run-hidden.vbs — launch a program with no console window (via wscript.exe)
' usage: wscript.exe run-hidden.vbs <exe> <arg1> [<arg2> ...]
' All arguments are passed quoted, so paths with spaces work.
Set shell = CreateObject("WScript.Shell")
Dim cmd
cmd = """" & WScript.Arguments(0) & """"
For i = 1 To WScript.Arguments.Count - 1
  cmd = cmd & " """ & WScript.Arguments(i) & """"
Next
shell.Run cmd, 0, False
