# Restore the user's startup directory before their code runs. A .zshenv
# that sets a different ZDOTDIR controls all subsequent login/rc files.
if [[ -n ${_office_original_zdotdir+x} ]]; then
    'builtin' 'export' ZDOTDIR="$_office_original_zdotdir"
    'builtin' 'unset' _office_original_zdotdir
else
    'builtin' 'unset' ZDOTDIR
fi
{
    if [[ -r ${ZDOTDIR-$HOME}/.zshenv || -r ${ZDOTDIR-$HOME}/.zshenv.zwc ]]; then
        'builtin' 'source' -- "${ZDOTDIR-$HOME}/.zshenv"
    fi
} always {
    if [[ -o interactive && -o rcs ]]; then
        'builtin' 'autoload' -Uz -- "${${(%):-%x}:A:h}/_office_prompt"
        'builtin' 'typeset' -ga precmd_functions
        precmd_functions+=(_office_prompt)
    fi
}
