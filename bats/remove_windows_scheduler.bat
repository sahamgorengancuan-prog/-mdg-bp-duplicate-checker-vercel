@echo off
setlocal
schtasks /Delete /TN "MDG_BP_GSheet_Indexed_Sync_0900" /F
schtasks /Delete /TN "MDG_BP_GSheet_Indexed_Sync_1500" /F
pause
