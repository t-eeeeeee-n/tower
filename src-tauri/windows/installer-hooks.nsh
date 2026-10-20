; Tower のインストーラに足す処理（tauri.conf.json の bundle.windows.nsis.installerHooks で読み込む）
;
; ウイルス対策ソフト（McAfee のファイアウォールなど）は、ポートを開くアプリの実行ファイルを握り続けることがあり、
; 上書きインストールが途中で止まる。握られたファイルでも名前の変更はできるので、上書きの前に古いファイルを
; 別の名前に移し、新しいファイルを置けるようにする。移した古いファイルは、次のインストールかアンインストールで消す。

; スタックの一番上のファイル名（拡張子なし）を、$INSTDIR の中で <名前>.old<番号>.exe に移す
Function TowerMoveAside
  Exch $0
  Push $1
  Push $2
  IfFileExists "$INSTDIR\$0.exe" 0 done
  StrCpy $1 0
  loop:
    StrCpy $2 "$INSTDIR\$0.old$1.exe"
    IfFileExists $2 next rename
  next:
    IntOp $1 $1 + 1
    IntCmp $1 20 done loop done
  rename:
    Rename "$INSTDIR\$0.exe" $2
  done:
  Pop $2
  Pop $1
  Pop $0
FunctionEnd

!macro TOWER_CLEAN_OLD
  ; まだ握られているものは消せないので、そのまま残して次の機会に消す
  Delete "$INSTDIR\${MAINBINARYNAME}.old*.exe"
  Delete "$INSTDIR\uninstall.old*.exe"
!macroend

!macro NSIS_HOOK_PREINSTALL
  !insertmacro TOWER_CLEAN_OLD
  Push "${MAINBINARYNAME}"
  Call TowerMoveAside
  Push "uninstall"
  Call TowerMoveAside
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  !insertmacro TOWER_CLEAN_OLD
  RMDir "$INSTDIR"
!macroend
