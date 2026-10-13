use scripting additions

on run
  try
    set deviceDialog to display dialog ¬
      "Вставьте код ELI-… или строку «Имя > ELI-…»" default answer "" ¬
      buttons {"Отмена", "Далее"} default button "Далее" cancel button "Отмена" ¬
      with title "EVE Key Generator"
    set deviceCode to text returned of deviceDialog
    set customerDefault to "Sergey"
    set separatorOffset to offset of ">" in deviceCode
    if separatorOffset > 1 then
      set inferredCustomer to text 1 thru (separatorOffset - 1) of deviceCode
      repeat
        if inferredCustomer is "" then exit repeat
        if inferredCustomer starts with " " then
          if (length of inferredCustomer) is 1 then
            set inferredCustomer to ""
          else
            set inferredCustomer to text 2 thru -1 of inferredCustomer
          end if
        else
          exit repeat
        end if
      end repeat
      repeat
        if inferredCustomer is "" then exit repeat
        if inferredCustomer ends with " " then
          if (length of inferredCustomer) is 1 then
            set inferredCustomer to ""
          else
            set inferredCustomer to text 1 thru -2 of inferredCustomer
          end if
        else
          exit repeat
        end if
      end repeat
      if inferredCustomer is not "" then set customerDefault to inferredCustomer
    end if

    set customerDialog to display dialog ¬
      "Имя клиента" default answer customerDefault ¬
      buttons {"Отмена", "Далее"} default button "Далее" cancel button "Отмена" ¬
      with title "EVE Key Generator"
    set customerName to text returned of customerDialog

    set modeResult to choose from list ¬
      {"7 дней", "30 дней", "90 дней", "365 дней", "Бессрочно", "Другой срок"} ¬
      with prompt "Срок действия ключа" default items {"30 дней"} ¬
      OK button name "Создать" cancel button name "Отмена" ¬
      with title "EVE Key Generator"
    if modeResult is false then return
    set selectedMode to item 1 of modeResult

    if selectedMode is "7 дней" then
      set expiryArguments to " --days 7"
    else if selectedMode is "30 дней" then
      set expiryArguments to " --days 30"
    else if selectedMode is "90 дней" then
      set expiryArguments to " --days 90"
    else if selectedMode is "365 дней" then
      set expiryArguments to " --days 365"
    else if selectedMode is "Бессрочно" then
      set expiryArguments to " --lifetime"
    else
      set customDialog to display dialog ¬
        "Количество дней: от 1 до 36500" default answer "30" ¬
        buttons {"Отмена", "Создать"} default button "Создать" cancel button "Отмена" ¬
        with title "EVE Key Generator"
      set customDays to text returned of customDialog
      set expiryArguments to " --days " & quoted form of customDays
    end if

    set appBundlePath to POSIX path of (path to me)
    set adminScript to appBundlePath & "Contents/Resources/license-admin.mjs"
    set nodePath to do shell script "/bin/zsh -lc 'command -v node'"
    if nodePath is "" then error "Node.js не найден"

    set commandLine to quoted form of nodePath & space & quoted form of adminScript & ¬
      " issue --device-code " & quoted form of deviceCode & ¬
      " --customer " & quoted form of customerName & expiryArguments
    set issueOutput to do shell script commandLine

    set outputPrefix to "Лицензия создана: "
    set firstLine to paragraph 1 of issueOutput
    if firstLine does not start with outputPrefix then ¬
      error "Генератор не вернул путь к лицензии"
    set licensePath to text (((length of outputPrefix) + 1)) thru -1 of firstLine
    set licenseToken to do shell script "/usr/bin/sed -n '1p' " & quoted form of licensePath
    set the clipboard to licenseToken

    set expiryLine to paragraph (count paragraphs of issueOutput) of issueOutput
    set resultDialog to display dialog ¬
      "Ключ создан и скопирован в буфер.\n\n" & expiryLine & "\n\n" & licensePath ¬
      buttons {"Закрыть", "Показать файл"} default button "Закрыть" ¬
      with title "EVE Key Generator" with icon note
    if button returned of resultDialog is "Показать файл" then
      tell application "Finder"
        reveal POSIX file licensePath
        activate
      end tell
    end if
  on error errorMessage number errorNumber
    if errorNumber is not -128 then
      display alert "Ключ не создан" message errorMessage as critical ¬
        buttons {"Закрыть"} default button "Закрыть"
    end if
  end try
end run
